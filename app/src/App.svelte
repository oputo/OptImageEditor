<script lang="ts">
  // OptImageEditor — phase 1-c: viewer with tabs, prefetch, recent files, single instance, "Open with" registration,
  // navigator, view rotation / flip, rulers, guides, grid, pixel grid; phase 1-d: compare (side by side / swipe / A-B toggle).
  import { onMount } from "svelte";
  import Viewer from "./lib/Viewer.svelte";
  import TabBar from "./lib/TabBar.svelte";
  import Navigator from "./lib/Navigator.svelte";
  import LayerPanel from "./lib/LayerPanel.svelte";
  import AnnotBar from "./lib/AnnotBar.svelte";
  import ExportDialog, { type ExportOptions } from "./lib/ExportDialog.svelte";
  import CanvasDialog from "./lib/CanvasDialog.svelte";
  import HelpOverlay from "./lib/HelpOverlay.svelte";
  import AiPanel from "./lib/AiPanel.svelte";
  import PaintBar from "./lib/PaintBar.svelte";
  import ColorPicker from "./lib/ColorPicker.svelte";
  import ChoiceDialog from "./lib/ChoiceDialog.svelte";
  import { PAINT_ICON, PAINT_LABEL, paint, stepSize, type PaintTool } from "./lib/paint.svelte";
  import { TOOL_KEY, annotTool, type Tool } from "./lib/annotations.svelte";
  import { SEL_ICON, SEL_LABEL, selTool, type SelMode, type SelTool } from "./lib/selection.svelte";
  import { viewOptions as opt, GRID_LABEL, COMPARE_LABEL, type GridMode } from "./lib/viewOptions.svelte";
  import type { ChannelView, CompareMode } from "./lib/renderer";
  import type { Renderer } from "./lib/renderer";
  import { SUPPORTED_EXT, isPsd } from "./lib/loader";
  import { baseName, isTauri, readTuning, READ_MODES, READ_MODE_LABEL } from "./lib/source";
  import {
    confirmDialog, infoDialog, onCloseRequested, onNativeDrop, setCloseGuard, onOpenPaths, openDefaultAppsSettings, pickFile,
    setOpenWithRegistration, startupPaths, toggleFullscreen,
  } from "./lib/desktop";
  import { ViewerState } from "./lib/viewerState.svelte";
  import { recent } from "./lib/recent.svelte";

  const vs = new ViewerState();
  let renderer = $state<Renderer | undefined>();
  $effect(() => { vs.renderer = renderer; });
  // mirror the view state for the UI (zoom %, rotation, flip)
  let rotation = $state(0);
  let flipX = $state(false);
  let cursor = $state<[number, number] | null>(null);
  // display: exposure (EV) for EXR / HDR, channel view (Ctrl+2 = RGB, Ctrl+3..5 = R/G/B, Ctrl+6 = alpha)
  let exposure = $state(0);
  let channel = $state<ChannelView>(0);
  $effect(() => { renderer?.setDisplay({ exposure, channel }); });
  const CHANNEL_LABEL = ["RGB", "R", "G", "B", "A"] as const;
  // stored value of the pixel under the mouse (read back from the GPU, at most once per frame)
  let pixel = $state<{ values: number[]; float: boolean } | null>(null);
  let pixelPending = false;
  function onCursor(p: [number, number] | null) {
    cursor = p;
    if (pixelPending) return;
    pixelPending = true;
    requestAnimationFrame(() => {
      pixelPending = false;
      const set = renderer?.activeSet;
      pixel = cursor && set ? renderer!.readPixel(set, cursor[0], cursor[1]) : null;
    });
  }
  const fmtPixel = (p: { values: number[]; float: boolean }) =>
    p.values.map((v, i) => `${"RGBA"[i]} ${p.float ? (Math.abs(v) >= 1000 ? v.toExponential(2) : v.toFixed(3)) : v}`).join("  ");
  $effect(() => {
    const r = renderer;
    if (!r) return;
    return r.onFrame(() => { vs.zoom = r.scale; rotation = r.rotation; flipX = r.flipX; });
  });

  let dragOver = $state(false);
  let showStats = $state(false);
  let readMode = $state(readTuning.mode);
  let openMenu = $state<"main" | "view" | null>(null);
  let toast = $state<string | null>(null);
  let fileInput: HTMLInputElement;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const active = $derived(vs.active);
  // closing the window asks first while any tab has unsaved layer edits
  const unsaved = $derived(vs.tabs.some((t) => t.layers?.dirty));
  $effect(() => { void setCloseGuard(unsaved); });
  const meta = $derived(active?.meta ?? null);
  // layers panel: load the PSD's layers when the panel is open (after 0.4 s on the same image, so that
  // stepping through a folder with ← / → does not decode every file's layers)
  $effect(() => {
    const t = active;
    const key = t?.key;
    // PSD: its layers; PNG / JPG / WebP: the image as one layer (also when a paint tool is picked)
    if (!((opt.layersPanel || paint.tool) && t?.meta && !t.layers && !t.meta.hdr)) return;
    const timer = setTimeout(() => { if (vs.active === t && t.key === key) vs.loadLayers(t); }, 400);
    return () => clearTimeout(timer);
  });
  const showExposure = $derived(!!(meta?.hdr || (vs.compare && vs.compareTab?.meta?.hdr)));
  const mb = (n: number) => (n / 2 ** 20).toFixed(1) + " MB";
  const ms = (n: number) => n.toFixed(0) + " ms";
  const shortPath = (p: string) => (p.length > 70 ? "…" + p.slice(-69) : p);

  function showToast(text: string) {
    toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 4000);
  }

  async function openPaths(paths: string[]) {
    if (!paths.length) return;
    const ok = await vs.openPaths(paths);
    if (!ok) showToast(`対応していない形式です（${SUPPORTED_EXT.join(" / ")}）`);
  }

  async function openDialog() {
    if (isTauri()) {
      const p = await pickFile();
      if (p) openPaths([p]);
    } else {
      fileInput.click();
    }
  }

  /** Ctrl+S / Ctrl+Shift+S: saves the active tab's layers as PSD. */
  async function save(saveAs: boolean) {
    const t = active;
    if (!t?.meta) return;
    const annots = t.annot.shapes.length;
    // nothing to save: no layer edits, no annotations, and the image is a file already (a pasted one is not)
    if (!saveAs && !annots && t.path && t.layers?.status === "ready" && !t.layers.dirty) { showToast("変更はありません"); return; }
    if (!saveAs && !annots && t.path && !t.layers) { showToast("変更はありません"); return; }
    if (t.layers?.status !== "ready") {
      showToast("レイヤーを読み込んでいます…");
      if (!(await vs.ensureLayers(t))) {
        await infoDialog(t.layers?.error ? `レイヤーを読み込めませんでした: ${t.layers.error}` : "この画像（EXR / HDR）の保存には対応していません");
        return;
      }
    }
    if (annots) {
      const c = await choose(
        `注釈が ${annots} 個あります。注釈は画像の上に表示しているだけで、そのままでは保存されません。`,
        ["注釈をレイヤーにして保存", "注釈なしで保存", "キャンセル"],
      );
      if (c === 2) return;
      if (c === 0) {
        const m = vs.annotationsToLayer(t);
        if (m) { await infoDialog(m); return; }
        annotTool.tool = null; // Ctrl+Z now undoes the new layer
      }
    }
    const l = t.layers!;
    if (!saveAs && !l.dirty && t.path) { showToast("変更はありません（注釈は保存していません）"); return; }
    try {
      if (await vs.save(t, saveAs)) showToast(`保存しました: ${t.name}（${(l.saved!.ms / 1000).toFixed(1)} 秒）`);
    } catch (e) {
      console.error(e);
      await infoDialog(`保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // a question with more than two answers (ChoiceDialog); resolves with the answer's index
  let choice = $state<{ text: string; options: string[]; resolve: (i: number) => void } | null>(null);
  function choose(text: string, options: string[]): Promise<number> {
    return new Promise((resolve) => (choice = { text, options, resolve: (i) => { choice = null; resolve(i); } }));
  }

  /** the annotation bar's "レイヤーに": the annotations become a layer "注釈" */
  async function annotToLayer() {
    const t = active;
    if (!t?.meta || !t.annot.shapes.length) return;
    if (t.layers?.status !== "ready" && !(await vs.ensureLayers(t))) { showToast("この画像はレイヤーにできません（EXR / HDR）"); return; }
    const m = vs.annotationsToLayer(t);
    if (m) { showToast(m); return; }
    annotTool.tool = null;
    showToast("注釈を「注釈」レイヤーにしました（Ctrl+Z で取り消し）");
  }

  /** layer editing shortcut on the active tab (needs the layers loaded) */
  function layerKey(f: (t: NonNullable<typeof active>) => void) {
    const t = active;
    if (t?.layers?.status === "ready") f(t);
    else if (t?.meta) showToast("レイヤーの編集はレイヤーパネル (F7) を開いてから");
  }

  // ---- 2-d: export / image size / canvas size / shortcut list
  let exportDlg = $state<{ mode: "export" | "size"; w: number; h: number } | null>(null);
  let canvasDlg = $state<{ w: number; h: number } | null>(null);
  let showHelp = $state(false);
  let showAi = $state(false);

  function openExport(mode: "export" | "size") {
    openMenu = null;
    const set = renderer?.activeSet;
    if (!active?.meta || !set) { showToast("画像を開いてください"); return; }
    if (set.hdr) { showToast("EXR / HDR の書き出しは未対応です"); return; }
    exportDlg = { mode, w: set.width, h: set.height };
  }
  async function doExport(o: ExportOptions) {
    exportDlg = null;
    try {
      const p = await vs.exportImage(o);
      if (p) showToast(`書き出しました: ${baseName(p)}`);
    } catch (e) {
      showToast(`書き出せませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  function openCanvas() {
    openMenu = null;
    const l = active?.layers;
    if (l?.status !== "ready") { showToast("カンバスサイズはレイヤーを読み込んでから（F7）"); return; }
    canvasDlg = { w: l.canvas.w, h: l.canvas.h };
  }
  function doCanvas(w: number, h: number, anchor: number) {
    canvasDlg = null;
    if (!active) return;
    const m = vs.canvasSize(active, w, h, anchor);
    if (m) showToast(m);
  }

  // ---- annotations
  const annotOn = $derived(annotTool.tool !== null && !!active?.meta && !vs.compare);
  const TOOL_BY_KEY = Object.fromEntries(Object.entries(TOOL_KEY).map(([t, k]) => [k, t as Tool]));
  // one tool at a time: a selection tool or an annotation tool
  function setSelTool(t: SelTool | null) {
    selTool.tool = t;
    if (t) paint.tool = null;
    if (t === "rect" || t === "ellipse") selTool.marquee = t;
    if (t === "lasso" || t === "poly") selTool.lasso = t;
    if (t) annotTool.tool = null;
  }
  function setAnnotTool(t: Tool | null) {
    annotTool.tool = t;
    if (t) { selTool.tool = null; paint.tool = null; }
  }
  function setPaintTool(t: PaintTool | null) {
    paint.tool = t;
    if (t) { selTool.tool = null; annotTool.tool = null; }
  }

  // ---- 3-b: painting
  const BRACKET: Record<string, boolean> = { "[": false, "{": false, "「": false, "]": true, "}": true, "」": true };
  let colorDlg = $state<"fg" | "bg" | null>(null);
  function onPaint(phase: "start" | "move" | "end" | "pick", x: number, y: number, pressure: number, e: PointerEvent): boolean | void {
    const t = active;
    if (!t) return false;
    if (phase === "pick") { const c = vs.pickColor(x, y, paint.params.eyedropper.size); if (c) { paint.fg = c; paint.save(); } return; }
    if (phase === "start") {
      const m = vs.paintBegin(t, x, y, pressure, paint.tool === "eraser", e.shiftKey);
      if (m) { showToast(m); return false; }
      return true;
    }
    if (phase === "move") vs.paintMove(x, y, pressure);
    else vs.paintEnd();
  }
  const paintTarget = $derived(active?.layers?.status === "ready"
    ? (active.layers.maskTarget ? "マスクに描画" : "レイヤーに描画")
    : "レイヤー未読み込み（F7）");

  // ---- 3-a: selection
  function onSelShape(tool: SelTool, pts: number[], mode: SelMode) {
    const t = active;
    if (!t) return;
    if (!pts.length) { if (mode === "replace") vs.deselect(t); return; }
    vs.selectShape(t, tool, pts, mode);
  }
  function msg(m: string | null | undefined) { if (m) showToast(m); }
  async function copySel(cut: boolean) {
    const t = active;
    if (!t?.meta) return;
    try { msg(await vs.copySelection(t, cut)); }
    catch (e) { showToast(`コピーできませんでした: ${e instanceof Error ? e.message : String(e)}`); }
  }

  function copyAnnotated() {
    if (!active?.meta) return;
    vs.copyAnnotated()
      .then(() => showToast(active?.annot.shapes.length ? "注釈込みの画像をコピーしました" : "画像をコピーしました（注釈なし）"))
      .catch((e) => showToast(`コピーできませんでした: ${e instanceof Error ? e.message : String(e)}`));
  }

  async function saveAnnotated() {
    if (!active?.meta) return;
    try {
      const p = await vs.saveAnnotatedPng();
      if (p) showToast(`保存しました: ${baseName(p)}`);
    } catch (e) {
      showToast(`保存できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Ctrl+V: an image on the clipboard opens in a new tab (Win+Shift+S screenshots etc.)
  function onPaste(e: ClipboardEvent) {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
    if (!file) { showToast("クリップボードに画像がありません"); return; }
    e.preventDefault();
    // a document with layers: a new layer (Photoshop); otherwise a new tab
    if (active?.layers?.status === "ready") vs.pasteAsLayer(active, file).then(msg).catch((err) => showToast(`貼り付けられませんでした: ${err}`));
    else vs.openPasted(file);
  }

  function toggleFlip() { if (renderer?.hasImage) renderer.setFlip(!renderer.flipX); }

  function fit() { renderer?.fit(); vs.zoom = renderer?.scale ?? 0; }
  function zoomTo(scale: number) {
    if (!renderer?.hasImage) return;
    renderer.zoomAt(scale, renderer.viewWidth / 2, renderer.viewHeight / 2);
    vs.zoom = renderer.scale;
  }

  async function registerOpenWith(register: boolean) {
    openMenu = null;
    try {
      const exe = await setOpenWithRegistration(register);
      if (register) {
        const go = await confirmDialog(
          "「プログラムから開く」に登録しました（現在のユーザーのみ）。\n\n" +
          `対象: ${SUPPORTED_EXT.map((e) => "." + e).join(" ")}\n登録した exe: ${exe}\n\n` +
          "既定のアプリにするには、画像を右クリック →［プログラムから開く］→［別のプログラムを選択］→ OptImageEditor を選び、「常にこのアプリを使う」をオンにしてください。\n\n" +
          "今すぐ Windows の「既定のアプリ」設定を開きますか？",
        );
        if (go) await openDefaultAppsSettings();
      } else {
        await infoDialog("登録を解除しました。");
      }
    } catch (e) {
      await infoDialog(`失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function onKey(e: KeyboardEvent) {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    // letters / digits by physical key: with the Japanese IME on, e.key is "Process" but e.code is still "KeyX" etc.
    const kk = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.code.startsWith("Digit") ? e.code.slice(5) : k.length === 1 ? k.toLowerCase() : k;
    // typing in a text / number field: only Ctrl shortcuts and function keys
    const t = e.target as HTMLElement;
    if (((t.tagName === "INPUT" && (t as HTMLInputElement).type !== "checkbox") || t.tagName === "SELECT") && !ctrl && !/^F\d+$/.test(k)) return;
    // text editing keys stay with the text field
    if ((t.tagName === "INPUT" || t.tagName === "TEXTAREA") && ((ctrl && ["a", "c", "x", "v", "z", "y"].includes(kk)) || k === "Delete" || k === "Backspace")) return;
    let handled = true;
    const cmp = vs.compare;
    if (exportDlg || canvasDlg || colorDlg || choice) return; // the dialog handles its keys
    if (showHelp && (k === "Escape" || k === "F1")) { showHelp = false; e.preventDefault(); return; }
    if (k === "Escape" && openMenu) openMenu = null;
    else if (k === "Escape" && cmp) vs.stopCompare();
    else if (!ctrl && !e.altKey && !e.shiftKey && kk === "c") { if (active?.meta || cmp) vs.toggleCompare(); }
    else if (cmp && !ctrl && !e.altKey && (kk === "1" || kk === "2" || kk === "3")) vs.updateCompare({ mode: (["side", "swipe", "toggle"] as const)[Number(kk) - 1] });
    else if (cmp && !ctrl && !e.altKey && kk === "x") vs.updateCompare({ mode: "toggle", showB: cmp.mode === "toggle" ? !cmp.showB : true });
    else if (k === "Escape" && annotOn) { if (active!.annot.selected !== null) active!.annot.selected = null; else annotTool.tool = null; }
    else if (k === "Escape" && selTool.tool) setSelTool(null);
    else if (k === "Escape" && paint.tool) setPaintTool(null);
    else if (!ctrl && !e.altKey && kk === "m" && active?.meta && !cmp && !annotOn) setSelTool(e.shiftKey ? (selTool.marquee === "rect" ? "ellipse" : "rect") : selTool.marquee);
    else if (!ctrl && !e.altKey && kk === "l" && active?.meta && !cmp && !annotOn) setSelTool(e.shiftKey ? (selTool.lasso === "lasso" ? "poly" : "lasso") : selTool.lasso);
    else if (ctrl && !e.shiftKey && !e.altKey && kk === "a") { if (active?.meta) vs.selectAll(active); }
    else if (ctrl && !e.shiftKey && !e.altKey && kk === "d") { if (active) vs.deselect(active); }
    else if (ctrl && e.shiftKey && !e.altKey && kk === "d") { if (active) vs.reselect(active); }
    else if (ctrl && e.shiftKey && !e.altKey && kk === "i") { if (active?.meta) vs.invertSelection(active); }
    else if (ctrl && !e.shiftKey && !e.altKey && kk === "c") copySel(false);
    else if (ctrl && !e.shiftKey && !e.altKey && kk === "x") copySel(true);
    else if (ctrl && !e.altKey && kk === "j" && active?.sel) layerKey((t) => msg(vs.layerViaSelection(t, e.shiftKey)));
    else if (!ctrl && !e.altKey && (k === "Delete" || k === "Backspace") && active?.sel && !annotOn) layerKey((t) => msg(t.layers!.maskTarget ? vs.hideInMask(t) : vs.clearSelection(t)));
    else if (ctrl && !e.shiftKey && !e.altKey && kk === "i" && active?.layers?.maskTarget) layerKey((t) => msg(vs.invertMask(t)));
    else if (k === "Escape" && renderer?.hasImage && renderer.rotation !== 0) renderer.rotateTo(0);
    else if (!ctrl && !e.altKey && !e.shiftKey && !annotOn && (kk === "b" || kk === "e" || kk === "i") && active?.meta && !cmp) setPaintTool(kk === "b" ? "brush" : kk === "e" ? "eraser" : "eyedropper");
    else if (!ctrl && !e.altKey && !annotOn && kk === "x" && !cmp) paint.swap();
    else if (!ctrl && !e.altKey && !annotOn && kk === "d" && !cmp) paint.reset();
    else if (!ctrl && !e.altKey && paint.tool && BRACKET[k] !== undefined) {
      // by the character, not the physical key: "[" sits elsewhere on a Japanese (JIS) keyboard
      const up = BRACKET[k];
      if (e.shiftKey) { if (paint.tool !== "eyedropper") paint.hardness = Math.round(paint.hardness * 4 + (up ? 1 : -1)) / 4; }
      else paint.diameter = stepSize(paint.diameter, up);
    }
    else if (!ctrl && !e.altKey && !e.shiftKey && paint.tool && paint.tool !== "eyedropper" && /^[0-9]$/.test(kk) && !cmp) paint.opacity = kk === "0" ? 1 : Number(kk) / 10;
    else if ((e.altKey || ctrl) && !e.shiftKey && (k === "Delete" || k === "Backspace") && active?.meta) layerKey((t) => msg(vs.fillSelection(t, e.altKey ? "fg" : "bg")));
    else if (!ctrl && !e.altKey && !e.shiftKey && TOOL_BY_KEY[kk] && active?.meta && !cmp) setAnnotTool(TOOL_BY_KEY[kk]);
    else if (ctrl && e.shiftKey && kk === "c") copyAnnotated();
    else if (ctrl && e.altKey && e.shiftKey && kk === "w") openExport("export");
    else if (ctrl && e.altKey && !e.shiftKey && kk === "i") openExport("size");
    else if (ctrl && e.altKey && !e.shiftKey && kk === "c") openCanvas();
    else if (k === "F1") showHelp = !showHelp;
    else if (k === "F8") showAi = !showAi;
    else if (annotOn && ctrl && (kk === "z" || kk === "y")) { if (kk === "y" || e.shiftKey) active!.annot.redo(); else active!.annot.undo(); }
    else if (annotOn && !ctrl && (k === "Delete" || k === "Backspace") && active!.annot.selected !== null) active!.annot.remove(active!.annot.selected!);
    else if (ctrl && (kk === "z" || kk === "y")) {
      const redo = kk === "y" || e.shiftKey;
      // layers loaded: the document's history (the selection is part of it); otherwise the selection's own
      if (active?.layers?.status === "ready") { if (redo) vs.redo(active); else vs.undo(active); }
      else if (!(active && vs.travelSelection(active, !redo))) layerKey(() => {});
    }
    else if (ctrl && !e.altKey && kk === "e") layerKey((t) => { const m = e.shiftKey ? vs.mergeVisible(t) : vs.mergeDown(t); if (m) showToast(m); });
    else if (ctrl && kk === "s") save(e.shiftKey);
    else if (ctrl && !e.shiftKey && !e.altKey && kk === "j") layerKey((t) => vs.duplicate(t));
    else if (ctrl && e.shiftKey && !e.altKey && kk === "n") layerKey((t) => vs.newLayer(t));
    else if (ctrl && e.altKey && kk === "g") layerKey((t) => vs.toggleClipping(t));
    else if (ctrl && !e.shiftKey && kk === "g") layerKey((t) => vs.groupSelected(t));
    else if (!ctrl && k === "Delete") layerKey((t) => vs.deleteSelected(t));
    else if (ctrl && kk === "r") opt.rulers = !opt.rulers;
    else if (ctrl && kk === "h") opt.extras = !opt.extras;
    else if (!ctrl && !e.altKey && kk === "n") opt.navigator = !opt.navigator;
    else if (!ctrl && !e.altKey && !e.shiftKey && kk === "g") opt.toggleGrid();
    else if (!ctrl && e.shiftKey && kk === "h") toggleFlip();
    else if (!ctrl && kk === "r") handled = false; // R + drag rotates (handled by the viewer)
    else if (ctrl && k === "Tab") vs.cycle(e.shiftKey ? -1 : 1);
    else if (ctrl && e.shiftKey && kk === "t") vs.reopenClosed();
    else if (ctrl && kk === "o") openDialog();
    else if (ctrl && kk === "w") vs.closeActive();
    else if (ctrl && !e.shiftKey && ["2", "3", "4", "5", "6"].includes(kk)) channel = (Number(kk) - 2) as ChannelView;
    else if (ctrl && kk === "0") fit();
    else if (ctrl && kk === "1") zoomTo(1);
    else if (ctrl && (k === "+" || k === "=" || k === ";")) zoomTo((renderer?.scale ?? 1) * 1.25);
    else if (ctrl && k === "-") zoomTo((renderer?.scale ?? 1) / 1.25);
    else if (!ctrl && (k === "ArrowRight" || k === "PageDown")) vs.step(1);
    else if (!ctrl && (k === "ArrowLeft" || k === "PageUp")) vs.step(-1);
    else if (!ctrl && k === "Home") vs.goTo(0);
    else if (!ctrl && k === "End") vs.goTo((active?.folder.length ?? 1) - 1);
    else if (k === "F11") toggleFullscreen();
    else if (k === "F7") opt.layersPanel = !opt.layersPanel;
    else if (k === "F4") { if (active?.layers?.status === "ready") vs.setUseLayers(active, !active.layers.useLayers); }
    else if (k === "F2") showStats = !showStats;
    else if (k === "F3") { readTuning.mode = READ_MODES[(READ_MODES.indexOf(readTuning.mode) + 1) % READ_MODES.length]; readMode = readTuning.mode; showStats = true; }
    else if (k === "F5") vs.reload();
    else handled = false;
    if (handled) e.preventDefault();
  }

  // HTML5 drop (browser build only; the desktop app uses native drop to get real paths)
  function onHtmlDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    if (isTauri()) return;
    for (const f of Array.from(e.dataTransfer?.files ?? [])) vs.openFile(f);
  }

  const statsText = $derived.by(() => {
    if (!meta || !active) return "";
    const cache = vs.cacheInfo;
    return [
      `file        ${meta.name}`,
      `path        ${meta.path ?? "(browser)"}`,
      `file size   ${mb(meta.stats.fileSize)}  (read ${mb(meta.stats.bytesRead)})`,
      `image       ${meta.width} x ${meta.height}  ${meta.bitsPerChannel}bit${meta.layerInfo ? "  " + meta.layerInfo : ""}${meta.note ? `  (${meta.note})` : ""}`,
      `via         ${meta.fromCache ? "GPU cache (prefetched / kept)" : meta.via}`,
      `read file   ${ms(meta.stats.readMs)}`,
      `decode      ${ms(meta.stats.decodeMs)}  (read+decode round-trip ${ms(meta.stats.workerMs)})`,
      `GPU upload  ${ms(meta.uploadMs)}  max tex ${renderer?.maxTextureSize ?? "?"}`,
      `TOTAL       ${meta.fromCache ? "0 ms (from GPU cache)" : ms(meta.totalMs)}`,
      `GPU cache   ${cache.count} images, ${mb(cache.bytes)}`,
      ...(active.layers?.stats ? [
        `layers      ${active.layers.count}  read ${ms(active.layers.stats.readMs)}  decode ${ms(active.layers.stats.decodeMs)}  upload ${ms(active.layers.stats.uploadMs)}`,
        `composite   ${ms(active.layers.stats.compositeMs)}  (${active.layers.stats.passes} passes)  showing ${active.layers.useLayers ? "layers" : "stored composite"}`,
      ] : []),
      `JS heap     ${(performance as unknown as { memory?: { usedJSHeapSize: number } }).memory ? mb((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize) : "n/a"}`,
    ].join("\n");
  });

  async function copyStats() {
    if (statsText) await navigator.clipboard.writeText(statsText);
  }

  onMount(() => {
    const unlisten: (() => void)[] = [];
    onNativeDrop({ over: (on) => (dragOver = on), drop: (paths) => openPaths(paths) }).then((u) => unlisten.push(u));
    onOpenPaths((paths) => openPaths(paths)).then((u) => unlisten.push(u));
    startupPaths().then((paths) => openPaths(paths));
    onCloseRequested(async () => confirmDialog("保存されていないレイヤーの変更があります。破棄して終了しますか？")).then((u) => unlisten.push(u));
    // browser build / reload of the webview
    const beforeUnload = (e: BeforeUnloadEvent) => { if (vs.hasUnsaved()) e.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    unlisten.push(() => window.removeEventListener("beforeunload", beforeUnload));
    const closeMenu = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".menu-wrap")) openMenu = null; };
    window.addEventListener("mousedown", closeMenu);
    // test hook for automated checks (browser build)
    (window as unknown as { __oie: unknown }).__oie = {
      vs,
      paint,
      openFile: (f: File) => {
        vs.openFile(f);
        return new Promise<void>((r) => { const t = setInterval(() => { if (!vs.active?.loading) { clearInterval(t); r(); } }, 20); });
      },
      get stats() { return statsText; },
      get error() { return vs.active?.error ?? null; },
    };
    return () => { unlisten.forEach((u) => u()); window.removeEventListener("mousedown", closeMenu); };
  });
</script>

<svelte:window onkeydown={onKey} onpaste={onPaste} ondragover={(e) => e.preventDefault()} ondrop={(e) => e.preventDefault()} />

<header class="toolbar">
  <div class="menu-wrap">
    <button class="menu-btn" class:active={openMenu === "main"} onclick={() => (openMenu = openMenu === "main" ? null : "main")} title="メニュー">≡</button>
    {#if openMenu === "main"}
      <div class="menu" role="menu">
        <div class="menu-head">最近使ったファイル</div>
        {#each recent.list as p (p)}
          <button class="item" role="menuitem" title={p} onclick={() => { openMenu = null; openPaths([p]); }}>
            <span class="fname">{baseName(p)}</span><span class="fdir">{shortPath(p)}</span>
          </button>
        {:else}
          <div class="empty">（まだありません）</div>
        {/each}
        {#if recent.list.length}
          <button class="item small" role="menuitem" onclick={() => { recent.clear(); }}>履歴を消去</button>
        {/if}
        <div class="menu-sep"></div>
        <button class="item" role="menuitem" disabled={!active?.meta} onclick={() => openExport("export")}>書き出し…<span class="fdir">Ctrl+Alt+Shift+W</span></button>
        <button class="item" role="menuitem" disabled={!active?.meta} onclick={() => openExport("size")}>画像解像度…<span class="fdir">Ctrl+Alt+I</span></button>
        <button class="item" role="menuitem" disabled={active?.layers?.status !== "ready"} onclick={openCanvas}>カンバスサイズ…<span class="fdir">Ctrl+Alt+C</span></button>
        <button class="item" role="menuitem" onclick={() => { openMenu = null; showHelp = true; }}>ショートカット一覧<span class="fdir">F1</span></button>
        {#if isTauri()}
          <div class="menu-sep"></div>
          <button class="item" role="menuitem" onclick={() => registerOpenWith(true)}>「プログラムから開く」に登録</button>
          <button class="item" role="menuitem" onclick={() => registerOpenWith(false)}>登録を解除</button>
        {/if}
      </div>
    {/if}
  </div>
  <button onclick={openDialog} title="開く (Ctrl+O)">開く</button>
  <input bind:this={fileInput} type="file" multiple accept={SUPPORTED_EXT.map((e) => "." + e).join(",")} hidden
    onchange={() => { for (const f of Array.from(fileInput.files ?? [])) vs.openFile(f); fileInput.value = ""; }} />
  <span class="sep"></span>
  <button onclick={() => vs.step(-1)} disabled={(active?.folder.length ?? 0) < 2} title="前の画像 (← / PageUp)">◀</button>
  <button onclick={() => vs.step(1)} disabled={(active?.folder.length ?? 0) < 2} title="次の画像 (→ / PageDown)">▶</button>
  <span class="sep"></span>
  <button onclick={fit} title="全体表示 (Ctrl+0)">全体</button>
  <button onclick={() => zoomTo(1)} title="100% (Ctrl+1)">100%</button>
  <span class="sep"></span>
  <button class:active={opt.layersPanel} onclick={() => (opt.layersPanel = !opt.layersPanel)} title="レイヤーパネル (F7)">レイヤー</button>
  <button class:active={!!vs.compare} disabled={!active?.meta && !vs.compare} onclick={() => vs.toggleCompare()} title="比較表示 (C)">比較</button>
  <div class="seg seltools" title="選択ツール（M: 長方形 / 楕円形、L: なげなわ / 多角形、Shift で切り替え）。Shift: 追加 / Alt: 除外 / Shift+Alt: 交差">
    {#each ["rect", "ellipse", "lasso", "poly"] as const as st (st)}
      <button class:on={selTool.tool === st} disabled={!active?.meta || !!vs.compare} title={SEL_LABEL[st]} onclick={() => setSelTool(selTool.tool === st ? null : st)}>{SEL_ICON[st]}</button>
    {/each}
  </div>
  <div class="seg seltools" title="ペイント（B: ブラシ / E: 消しゴム / I: スポイト）">
    {#each ["brush", "eraser", "eyedropper"] as const as pt (pt)}
      <button class:on={paint.tool === pt} disabled={!active?.meta || !!vs.compare} title={PAINT_LABEL[pt]} onclick={() => setPaintTool(paint.tool === pt ? null : pt)}>{PAINT_ICON[pt]}</button>
    {/each}
  </div>
  <div class="colors" title="描画色 / 背景色（クリックで変更、X: 入れ替え、D: 初期値）">
    <button class="cbg" style:background={paint.bg} aria-label="背景色" onclick={() => (colorDlg = "bg")}></button>
    <button class="cfg" style:background={paint.fg} aria-label="描画色" onclick={() => (colorDlg = "fg")}></button>
    <button class="cx" onclick={() => paint.swap()} title="入れ替え (X)">⇄</button>
  </div>
  <button class:active={annotOn} disabled={!active?.meta || !!vs.compare} onclick={() => setAnnotTool(annotTool.tool ? null : "pen")}
    title="注釈（ペン P / 直線 L / 矢印 A / 四角 U / テキスト T / 選択 V）。Ctrl+Shift+C で注釈込みの画像をコピー">注釈</button>
  <button class:active={showAi} onclick={() => (showAi = !showAi)} title="AI（ComfyUI）: 背景除去 / 指示で編集 (F8)">AI</button>
  <div class="menu-wrap">
    <button class:active={openMenu === "view"} onclick={() => (openMenu = openMenu === "view" ? null : "view")} title="表示（ナビゲーター / 定規 / ガイド / グリッド / 回転）">表示 ▾</button>
    {#if openMenu === "view"}
      <div class="menu view-menu" role="menu">
        <label class="check"><input type="checkbox" bind:checked={opt.navigator} />ナビゲーター<kbd>N</kbd></label>
        <label class="check"><input type="checkbox" bind:checked={opt.rulers} />定規<kbd>Ctrl+R</kbd></label>
        <div class="menu-sep"></div>
        <label class="check"><input type="checkbox" bind:checked={opt.extras} />ガイド・グリッドを表示<kbd>Ctrl+H</kbd></label>
        <label class="check sub"><input type="checkbox" bind:checked={opt.guides} disabled={!opt.extras} />ガイド<span class="note">定規からドラッグで作成、定規へ戻すと削除</span></label>
        <div class="row sub">
          <span class="lbl">グリッド<kbd>G</kbd></span>
          <div class="seg">
            {#each Object.keys(GRID_LABEL) as g (g)}
              <button class:on={opt.grid === g} disabled={!opt.extras} onclick={() => (opt.grid = g as GridMode)}>{GRID_LABEL[g as GridMode]}</button>
            {/each}
          </div>
        </div>
        <div class="row sub">
          <span class="lbl">格子の間隔</span>
          <input class="num" type="number" min="1" max="100000" bind:value={opt.gridPx} disabled={!opt.extras} /> px
        </div>
        <label class="check sub"><input type="checkbox" bind:checked={opt.pixelGrid} disabled={!opt.extras} />ピクセルグリッド<span class="note">800% 以上で表示</span></label>
        <button class="item small" disabled={!active || (!active.guides.v.length && !active.guides.h.length)}
          onclick={() => { if (active) { active.guides.v = []; active.guides.h = []; } }}>このタブのガイドをすべて消去</button>
        <div class="menu-sep"></div>
        <div class="row">
          <span class="lbl">チャンネル<kbd>Ctrl+2〜6</kbd></span>
          <div class="seg">
            {#each CHANNEL_LABEL as c, i (c)}
              <button class:on={channel === i} onclick={() => (channel = i as ChannelView)}>{c}</button>
            {/each}
          </div>
        </div>
        <div class="menu-sep"></div>
        <div class="row">
          <span class="lbl">回転 {rotation.toFixed(1).replace(/\.0$/, "")}°</span>
          <button class="mini" disabled={!active?.meta} onclick={() => renderer?.rotateTo(rotation - 90)}>⟲ 90°</button>
          <button class="mini" disabled={!active?.meta} onclick={() => renderer?.rotateTo(rotation + 90)}>⟳ 90°</button>
          <button class="mini" disabled={!active?.meta || rotation === 0} onclick={() => renderer?.rotateTo(0)}>0° に戻す<kbd>Esc</kbd></button>
        </div>
        <div class="note-line">R を押しながらドラッグで回転（Shift で 15° 刻み）</div>
        <label class="check"><input type="checkbox" checked={flipX} disabled={!active?.meta} onchange={toggleFlip} />左右反転して表示<kbd>Shift+H</kbd></label>
      </div>
    {/if}
  </div>
  <span class="spacer"></span>
  <button class:active={showStats} onclick={() => (showStats = !showStats)} title="計測を表示 (F2)">計測</button>
</header>

{#if vs.tabs.length}
  <TabBar tabs={vs.tabs} activeId={vs.activeId} onactivate={(id) => vs.activate(id)} onclose={(id) => vs.close(id)} onopen={openDialog} />
{/if}

{#if vs.compare && active}
  {@const c = vs.compare}
  <div class="cmpbar">
    <span class="tag a">A</span><span class="cname" title={active.path ?? active.name}>{active.name}</span>
    <span class="vs">⇔</span>
    <span class="tag b">B</span>
    <select value={c.bId} onchange={(e) => vs.updateCompare({ bId: Number((e.currentTarget as HTMLSelectElement).value) })} title="比べる画像（タブ）。B のタブをクリックすると A と B が入れ替わる">
      {#each vs.tabs as t (t.id)}
        <option value={t.id}>{t.id === vs.activeId ? "（同じ画像）" : ""}{t.name}</option>
      {/each}
    </select>
    <span class="sep"></span>
    <div class="seg">
      {#each Object.keys(COMPARE_LABEL) as m, i (m)}
        <button class:on={c.mode === m} onclick={() => vs.updateCompare({ mode: m as CompareMode })} title="キー {i + 1}">{COMPARE_LABEL[m as CompareMode]}</button>
      {/each}
    </div>
    {#if c.mode === "side"}
      <label class="cchk" title="ズーム・位置・回転を左右で連動する（オフで左右を別々に操作）"><input type="checkbox" checked={c.linked} onchange={(e) => vs.updateCompare({ linked: (e.currentTarget as HTMLInputElement).checked })} />連動</label>
    {:else if c.mode === "toggle"}
      <button onclick={() => vs.updateCompare({ showB: !c.showB })} title="A と B を切り替える (X)">{c.showB ? "B を表示中" : "A を表示中"} ⇄ <kbd>X</kbd></button>
    {:else}
      <span class="hint-small">境界線をドラッグ</span>
    {/if}
    <span class="sep"></span>
    <span class="lbl-small">B の大きさ</span>
    <div class="seg">
      <button class:on={c.fitB} onclick={() => vs.updateCompare({ fitB: true })} title="B を A の大きさに合わせて拡大縮小する（縦横比は保ち、中央に揃える。解像度違いの比較用）">A に合わせる</button>
      <button class:on={!c.fitB} onclick={() => vs.updateCompare({ fitB: false })} title="実ピクセルで左上を揃える">実ピクセル</button>
    </div>
    {#if vs.compareTab?.meta && active.meta && (vs.compareTab.meta.width !== active.meta.width || vs.compareTab.meta.height !== active.meta.height)}
      <span class="hint-small">A {active.meta.width}×{active.meta.height} / B {vs.compareTab.meta.width}×{vs.compareTab.meta.height}</span>
    {/if}
    <span class="spacer"></span>
    <button onclick={() => vs.stopCompare()} title="比較を終了 (C / Esc)">終了 <kbd>Esc</kbd></button>
  </div>
{/if}

<div class="workspace">
<main
  class="stage"
  class:drag-over={dragOver}
  ondragover={(e) => { e.preventDefault(); if (!isTauri()) dragOver = true; }}
  ondragleave={() => { if (!isTauri()) dragOver = false; }}
  ondrop={onHtmlDrop}
>
  {#if paint.tool && active?.meta && !vs.compare}<PaintBar target={paintTarget} onclose={() => setPaintTool(null)} />{/if}
  {#if colorDlg}<ColorPicker value={colorDlg === "fg" ? paint.fg : paint.bg} title={colorDlg === "fg" ? "描画色" : "背景色"}
    onchange={(h) => { if (colorDlg === "fg") paint.fg = h; else paint.bg = h; paint.save(); }} onclose={() => (colorDlg = null)} />{/if}
  {#if annotOn}<AnnotBar annot={active?.annot ?? null} oncopy={copyAnnotated} onsave={saveAnnotated} onlayer={annotToLayer} />{/if}
  <Viewer bind:renderer guides={active?.guides ?? null} annot={active?.annot ?? null} sel={active?.sel ?? null} onselshape={onSelShape} onpaint={onPaint} oncursor={onCursor}
    labels={vs.compare && active ? { a: active.name, b: vs.compareTab?.name ?? "" } : null}
    onsplit={(v) => vs.updateCompare({ split: v })} />
  {#if vs.compare && vs.compareTab?.loading}<div class="busy">B を読み込み中…</div>{/if}
  {#if opt.navigator && active?.meta}<Navigator {renderer} zoom={vs.zoom} />{/if}
  {#if !active}
    <div class="start">
      <div class="hint">PSD / PSB / PNG / JPG / WebP をドロップ、または「開く」（Ctrl+O）</div>
      {#if recent.list.length}
        <div class="recent">
          <div class="recent-head">最近使ったファイル</div>
          {#each recent.list.slice(0, 10) as p (p)}
            <button class="recent-item" title={p} onclick={() => openPaths([p])}>
              <span class="fname">{baseName(p)}</span><span class="fdir">{shortPath(p)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else if active.error}
    <div class="hint error">{active.error}</div>
  {/if}
  {#if active?.loading}<div class="busy">読み込み中…</div>{/if}
  {#if toast}<div class="toast">{toast}</div>{/if}
  {#if exportDlg && active}
    <ExportDialog w0={exportDlg.w} h0={exportDlg.h} name={active.name} mode={exportDlg.mode}
      hasAnnotations={active.annot.shapes.length > 0} isPsd={isPsd(active.name)}
      onexport={doExport} onclose={() => (exportDlg = null)} />
  {/if}
  {#if choice}<ChoiceDialog text={choice.text} options={choice.options} onchoose={choice.resolve} />{/if}
  {#if canvasDlg}<CanvasDialog w0={canvasDlg.w} h0={canvasDlg.h} onapply={doCanvas} onclose={() => (canvasDlg = null)} />{/if}
  {#if showHelp}<HelpOverlay onclose={() => (showHelp = false)} />{/if}
  {#if showAi}<AiPanel {vs} tab={active} onclose={() => (showAi = false)} onmsg={showToast} />{/if}
  {#if showStats && meta}
    <div class="stats">
      <pre>{statsText}</pre>
      <span class="hint-keys">F3: 読み込み方式 [{READ_MODE_LABEL[readMode]}] を切替 ／ F5: 再読み込み</span>
      <button onclick={copyStats}>コピー</button>
    </div>
  {/if}
</main>
{#if opt.layersPanel}<LayerPanel {vs} tab={active} onsave={save} onmsg={showToast} />{/if}
</div>

<footer class="statusbar">
  {#if active && meta}
    <span class="name" title={meta.path ?? meta.name}>{meta.name}</span>
    <span>{meta.width} × {meta.height}</span>
    <span>{meta.bitsPerChannel}bit{meta.hdr ? " float" : ""}</span>
    {#if meta.hdr && meta.hdr.info.layers.length > 1}
      <select class="layer-sel" value={meta.hdr.layer} title="EXR のレイヤー（チャンネルのまとまり）"
        onchange={(e) => { vs.setLayer(Number((e.currentTarget as HTMLSelectElement).value)); (e.currentTarget as HTMLSelectElement).blur(); }}>
        {#each meta.hdr.info.layers as l, i (i)}<option value={i}>{l.name}</option>{/each}
      </select>
      <span>{meta.hdr.info.format} {meta.hdr.info.compression}</span>
    {:else if meta.layerInfo}<span>{meta.layerInfo}</span>{/if}
    {#if active.folder.length && active.folderIndex >= 0}<span>{active.folderIndex + 1} / {active.folder.length}</span>{/if}
    <span class="spacer"></span>
    {#if showExposure}
      <span class="ev" title="露出（EXR / HDR の表示のみ。ダブルクリックで 0 に戻す）">
        露出 <input type="range" min="-10" max="10" step="0.1" bind:value={exposure} ondblclick={() => (exposure = 0)} />
        <span class="evv">{exposure > 0 ? "+" : ""}{Number(exposure).toFixed(1)} EV</span>
      </span>
    {/if}
    {#if channel !== 0}<button class="chip" title="クリックで RGB 表示に戻す (Ctrl+2)" onclick={() => (channel = 0)}>{CHANNEL_LABEL[channel]} チャンネル</button>{/if}
    {#if cursor && cursor[0] >= 0 && cursor[1] >= 0 && cursor[0] < meta.width && cursor[1] < meta.height}
      <span class="coord">x {Math.floor(cursor[0])}  y {Math.floor(cursor[1])}</span>
      {#if pixel}<span class="coord px">{fmtPixel(pixel)}</span>{/if}
    {/if}
    {#if active.sel}<button class="chip" title="クリックで選択を解除 (Ctrl+D)" onclick={() => vs.deselect(active)}>選択 {active.sel.w} × {active.sel.h}</button>{/if}
    {#if rotation !== 0}<button class="chip" title="クリックで 0° に戻す (Esc)" onclick={() => renderer?.rotateTo(0)}>回転 {rotation.toFixed(1).replace(/\.0$/, "")}°</button>{/if}
    {#if flipX}<button class="chip" title="クリックで反転を解除 (Shift+H)" onclick={toggleFlip}>左右反転</button>{/if}
    <span>{(vs.zoom * 100).toFixed(vs.zoom < 0.1 ? 1 : 0)}%</span>
    <span>{meta.fromCache ? "cache" : `${meta.totalMs.toFixed(0)} ms`}</span>
  {:else}
    <span class="spacer"></span>
  {/if}
</footer>

<style>
  .toolbar, .statusbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    background: var(--panel);
    flex: none;
  }
  .toolbar { height: 36px; border-bottom: 1px solid var(--border); }
  .statusbar { height: 24px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; gap: 14px; font-variant-numeric: tabular-nums; }
  .statusbar .name { color: var(--text); max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spacer { flex: 1; }
  .sep { width: 1px; height: 20px; background: var(--border); margin: 0 4px; }
  button {
    background: #3a3a3a;
    color: var(--text);
    border: 1px solid #4a4a4a;
    border-radius: 4px;
    padding: 3px 10px;
    font: inherit;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: #454545; }
  button:disabled { opacity: 0.4; cursor: default; }
  button.active { border-color: var(--accent); color: var(--accent); }

  .menu-wrap { position: relative; }
  .menu-btn { font-size: 16px; line-height: 1; padding: 2px 9px 4px; }
  .menu {
    position: absolute; top: 32px; left: 0; z-index: 20;
    min-width: 320px; max-width: 520px; max-height: 70vh; overflow-y: auto;
    background: #2b2b2b; border: 1px solid #4a4a4a; border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); padding: 6px;
    display: flex; flex-direction: column;
  }
  .menu-head { color: var(--muted); font-size: 11px; padding: 4px 8px; }
  .menu-sep { height: 1px; background: var(--border); margin: 6px 2px; }
  .menu .empty { color: var(--muted); padding: 4px 8px 8px; }
  .item {
    display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
    background: transparent; border: none; border-radius: 4px; padding: 5px 8px; text-align: left;
  }
  .item:hover:not(:disabled) { background: #3a3a3a; }
  .item.small { color: var(--muted); font-size: 12px; }
  .fname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .fdir { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

  .cmpbar {
    display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 8px; flex: none;
    background: #262a30; border-bottom: 1px solid var(--border); font-size: 12px; white-space: nowrap;
  }
  .cmpbar button { padding: 2px 8px; display: flex; gap: 6px; align-items: center; }
  .cmpbar kbd { margin-left: 0; }
  .cmpbar select { background: #1e1e1e; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px; padding: 2px 4px; font: inherit; max-width: 280px; }
  .tag { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 3px; color: #fff; font-weight: 600; font-size: 11px; }
  .tag.a { background: rgb(30, 90, 160); }
  .tag.b { background: rgb(150, 70, 20); }
  .cname { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
  .vs { color: var(--muted); }
  .cchk { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  .cchk input { margin: 0; accent-color: var(--accent); }
  .hint-small, .lbl-small { color: var(--muted); font-size: 11px; }
  .view-menu { min-width: 430px; max-width: 480px; gap: 2px; }
  .check { display: flex; align-items: center; gap: 8px; white-space: nowrap; padding: 4px 8px; border-radius: 4px; cursor: pointer; }
  .check:hover { background: #3a3a3a; }
  .check input { margin: 0; accent-color: var(--accent); }
  .sub { padding-left: 26px; }
  kbd { margin-left: auto; color: var(--muted); font: 11px Consolas, "Cascadia Mono", monospace; }
  .note { color: var(--muted); font-size: 11px; margin-left: 4px; }
  .note-line { color: var(--muted); font-size: 11px; padding: 0 8px 4px; }
  .row { display: flex; align-items: center; gap: 6px; padding: 4px 8px; }
  .row .lbl { display: flex; gap: 8px; min-width: 96px; white-space: nowrap; }
  .seg { display: flex; }
  .seg button { border-radius: 0; padding: 2px 8px; margin-left: -1px; }
  .seg button:first-child { border-radius: 4px 0 0 4px; }
  .seg button:last-child { border-radius: 0 4px 4px 0; }
  .seg button.on { background: #2f4f73; border-color: var(--accent); color: #fff; position: relative; }
  .num { width: 72px; background: #1e1e1e; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px; padding: 2px 4px; font: inherit; }
  .mini { padding: 2px 8px; display: flex; gap: 6px; align-items: center; white-space: nowrap; }
  .mini kbd { margin-left: 0; }
  .statusbar .coord { color: var(--text); white-space: pre; }
  .statusbar .coord.px { font-family: Consolas, "Cascadia Mono", monospace; font-size: 11px; color: #cfe3ff; }
  .ev { display: flex; align-items: center; gap: 6px; }
  .ev input { width: 120px; accent-color: var(--accent); }
  .evv { width: 56px; font-variant-numeric: tabular-nums; color: var(--text); }
  .layer-sel { background: #1e1e1e; color: var(--text); border: 1px solid #4a4a4a; border-radius: 3px; font: inherit; font-size: 12px; padding: 0 4px; max-width: 220px; }
  .chip { background: #2f4f73; border: 1px solid var(--accent); color: #fff; border-radius: 9px; padding: 0 8px; font-size: 11px; line-height: 16px; }
  .seltools button { padding: 2px 7px; min-width: 28px; }
  .colors { position: relative; width: 50px; height: 30px; flex: none; }
  .colors button { position: absolute; width: 20px; height: 20px; padding: 0; border: 1px solid #ddd; border-radius: 2px; box-shadow: 0 0 0 1px #000; }
  .colors .cfg { left: 0; top: 0; z-index: 1; }
  .colors .cbg { left: 10px; top: 9px; }
  .colors .cx { left: 31px; top: -2px; width: 14px; height: 14px; border: none; box-shadow: none; background: transparent; font-size: 10px; color: var(--muted); }
  .workspace { flex: 1; min-height: 0; display: flex; }
  .stage { position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
  .stage.drag-over { outline: 2px dashed var(--accent); outline-offset: -6px; }
  .start {
    position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px;
    pointer-events: none;
  }
  .hint { color: var(--muted); font-size: 15px; padding: 20px; text-align: center; pointer-events: none; }
  .stage > .hint { position: absolute; inset: 0; display: grid; place-items: center; }
  .hint.error { color: #ffb4a8; }
  .recent { display: flex; flex-direction: column; min-width: 360px; max-width: 640px; pointer-events: auto; }
  .recent-head { color: var(--muted); font-size: 12px; padding: 0 8px 4px; }
  .recent-item {
    display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
    background: transparent; border: none; padding: 5px 8px; text-align: left; border-radius: 4px;
  }
  .recent-item:hover { background: #2e2e2e !important; }
  .busy, .toast {
    position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.75); padding: 6px 14px; border-radius: 4px; pointer-events: none;
  }
  .toast { color: #ffb4a8; top: auto; bottom: 12px; }
  .stats {
    position: absolute; right: 10px; bottom: 10px;
    background: rgba(0, 0, 0, 0.75); border: 1px solid var(--border); border-radius: 4px;
    padding: 8px 10px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
  }
  .hint-keys { color: var(--muted); font-size: 11px; }
  .stats pre { margin: 0; font: 12px/1.5 Consolas, "Cascadia Mono", monospace; color: #cfe3ff; white-space: pre; user-select: text; }
</style>
