// Viewer state: tabs, per-tab folder navigation, GPU texture cache and prefetch of neighbour images.
//
// GPU cache policy (phase 1-b): keep textures only for
//   1. the active tab, 2. the next / previous image in the active tab's folder (prefetched),
//   3. the two most recently used other tabs.
//   (while comparing, image B is kept right after the active image)
// Everything else is freed; a tab whose texture was freed is decoded again when activated (~0.2 s).
import { buildPsd, isPsd, loadImage, loadLayers, SUPPORTED_EXT, type LoadedImage } from "./loader";
import { Compositor, type LayerDoc } from "./compositor";
import { LOCK_ALL, LOCK_TRANSPARENCY, THUMB, cloneTree, maskThumbOf, pixelsLocked, thumbOf, toPlan, type DocLayer, type PlanNode, type PsdDocData } from "./psdDoc";
import type { CompareMode, Orientation, Renderer, TextureSet, ViewState } from "./renderer";
import { viewOptions } from "./viewOptions.svelte";
import { BrowserFileSource, TauriFileSource, baseName, isTauri, type FileSource } from "./source";
import { confirmDialog, copyImageFallback, listFolderImages, savePsd, saveDialog, setWindowTitle, writeFile } from "./desktop";
import { recent } from "./recent.svelte";
import { Annotations, drawShape, flattenToCanvas, flattenToPng, type Shape } from "./annotations.svelte";
import { cropGrey, mapPoint, transformPixels, type CropRect, type DocTransform } from "./crop.svelte";
import { Painter, applyTiles, type PatchTile } from "./painter";
import { hexToRgb, paint, rgbToHex } from "./paint.svelte";
import { comfy, loadWorkflow, type Progress, type WorkflowKind } from "./comfy";
import {
  Sel, allSel, clearPixels, selAt, trimSel, combine, ellipseSel, invertSel, maskPixels, polySel, rectSel, selFromAlpha, shiftSel,
  type SelMode, type SelTool,
} from "./selection.svelte";
import { applyMask, crop, decode, editRegion, featheredPatch, fitMax, fitPixels, over, toPng, trim, type Pixels, type Rect } from "./ai";

export type ImageMeta = Omit<LoadedImage, "image" | "release"> & {
  uploadMs: number;
  /** time until the image was on screen (decode + upload, or ~0 when it came from the cache) */
  totalMs: number;
  fromCache: boolean;
};

type CacheEntry = { set: TextureSet; meta: ImageMeta };

export type Tab = {
  id: number;
  /** cache key: lower-cased path, or "file:<id>" for files opened in the browser build */
  key: string;
  path: string | null;
  file: File | null;
  name: string;
  folder: string[];
  folderIndex: number;
  meta: ImageMeta | null;
  view: ViewState | null;
  /** rotation / flip kept while stepping through the folder (the zoom is reset to fit) */
  orient: Orientation | null;
  /** guides in image px (vertical guides at x, horizontal guides at y); kept while stepping through the folder */
  guides: Guides;
  /** EXR layer (channel group) shown; reset to 0 when stepping to another file */
  layer: number;
  /** PSD layers (phase 2-a): loaded on demand when the layers panel is open */
  layers: LayersState | null;
  /** annotations drawn over the image (reset when the tab shows another file) */
  annot: Annotations;
  /** selection (canvas px; reset when the tab shows another file) and the last one removed (Ctrl+Shift+D) */
  sel: Sel | null;
  lastSel: Sel | null;
  loading: boolean;
  error: string | null;
  token: number;
};

export type Guides = { v: number[]; h: number[] };

/** PSD layer tree of a tab. `useLayers`: show the GPU composite of the layers instead of the composite stored in the file. */
export type LayersState = {
  status: "loading" | "ready" | "error";
  error: string | null;
  tree: DocLayer[];
  count: number;
  useLayers: boolean;
  /** the active layer (shown in the properties); always part of `selection` when set */
  selectedId: number | null;
  /** selected layers (Ctrl / Shift + click) */
  selection: number[];
  /** load / composite timings for the stats panel */
  stats: { readMs: number; decodeMs: number; uploadMs: number; compositeMs: number; passes: number } | null;
  /** difference to the stored composite (computed on request) */
  diff: { max: number; mean: number; over2: number; over8: number } | null;
  /** edited since loaded / saved */
  dirty: boolean;
  undoCount: number;
  redoCount: number;
  saving: boolean;
  /** what the running save is doing (shown in the panel; also logged to the console with timings) */
  savePhase: string | null;
  /** last save: time and size */
  saved: { ms: number; bytes: number; path: string } | null;
  /** layers (groups included) in the file on disk, in the post-order the source ids refer to */
  fileCount: number;
  canvas: Canvas;
  /** edits act on the active layer's mask (its mask thumbnail was clicked) */
  maskTarget: boolean;
  /** layer whose mask is shown instead of the image (Alt+click on the mask thumbnail) */
  maskView: number | null;
};

/** Undo history of a tab's layer tree (snapshots of the tree; pixels are not edited in 2-b). */
/** Canvas of a layered document: size, and how far the file's layers have moved (canvas size changes not saved yet). */
/** canvas size, and where the file's layers went: x' = m0 x + m1 y + ox, y' = m2 x + m3 y + oy (m: rotation / flip,
 *  identity when absent) */
export type Canvas = { w: number; h: number; ox: number; oy: number; m?: [number, number, number, number] };
/** pixels changed in place by a stroke (layer `id`'s texture or mask), applied backwards / forwards by undo / redo */
type Patch = { id: number; mask: boolean; tiles: PatchTile[]; bytes: number };
/** `patch`: the pixel change from this state to the next one (strokes) */
/** `view`: guides and annotations before a crop / rotation (they move with the document) */
type Snapshot = { tree: DocLayer[]; canvas: Canvas; sel: Sel | null; patch?: Patch; view?: ViewMarks };
type ViewMarks = { guides: Guides; shapes: Shape[] };
type History = { undo: Snapshot[]; redo: Snapshot[]; lastKey: string | null; lastTime: number };
const HISTORY_MAX = 100;

/** Comparison of the active tab (A) with tab `bId` (B; may be the same tab). */
export type Compare = { bId: number; mode: CompareMode; linked: boolean; fitB: boolean; split: number; showB: boolean };

const KIND_DONE: Record<WorkflowKind, string> = { bg_remove: "背景を除去しました", edit: "編集しました" };

const GPU_BUDGET = 2 * 1024 ** 3; // bytes, incl. mipmaps
const KEEP_OTHER_TABS = 2;
const PREFETCH_DELAY_MS = 150;

const isSupported = (p: string) => SUPPORTED_EXT.includes(p.split(".").pop()?.toLowerCase() ?? "");
const keyOf = (path: string) => path.toLowerCase();
/** GPU cache key of what a tab shows (EXR layers other than the first are cached separately) */
const cacheKey = (t: Tab) => (t.layer ? `${t.key}#${t.layer}` : t.key);

export class ViewerState {
  tabs = $state<Tab[]>([]);
  activeId = $state<number | null>(null);
  zoom = $state(0);
  /** bumps whenever the GPU cache changes (for the stats panel) */
  cacheVersion = $state(0);
  compare = $state<Compare | null>(null);

  renderer: Renderer | undefined;
  private compositor: Compositor | null = null;
  /** GPU side of the loaded layer trees, per tab id */
  private docs = new Map<number, LayerDoc>();
  private compositePending = new Set<number>();
  private histories = new Map<number, History>();
  /** selection undo of tabs without layers (reset when the tab shows another file: `key`) */
  private selHistories = new Map<number, { key: string; undo: (Sel | null)[]; redo: (Sel | null)[] }>();
  /** paths whose original was already kept as .bak in this session */
  private backedUp = new Set<string>();
  /** tabs whose "not rendered" warning was already confirmed (asked once per tab) */
  private warnedUnrendered = new Set<number>();
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<CacheEntry>>();
  private mru: number[] = [];
  private closed: { path: string }[] = [];
  private prefetchToken = 0;
  private seq = 0;

  get active(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  get compareTab(): Tab | null {
    return this.compare ? this.tab(this.compare.bId) : null;
  }

  get cacheInfo() {
    void this.cacheVersion;
    let bytes = 0;
    for (const e of this.cache.values()) bytes += e.set.bytes;
    return { count: this.cache.size, bytes };
  }

  private tab(id: number) {
    return this.tabs.find((t) => t.id === id) ?? null;
  }

  // ---------------------------------------------------------------- opening

  /** Opens files (each in its own tab; an already open file just gets activated). Returns false if nothing was supported. */
  async openPaths(paths: string[]): Promise<boolean> {
    const ok = paths.filter(isSupported);
    let lastId: number | null = null;
    for (const path of ok) {
      const existing = this.tabs.find((t) => t.path && keyOf(t.path) === keyOf(path));
      if (existing) { lastId = existing.id; continue; }
      const id = ++this.seq;
      this.tabs.push({
        id, key: keyOf(path), path, file: null, name: baseName(path),
        folder: [], folderIndex: -1, meta: null, view: null, orient: null, guides: { v: [], h: [] }, layer: 0, layers: null, annot: new Annotations(), sel: null, lastSel: null, loading: false, error: null, token: 0,
      });
      lastId = id;
      // folder listing in the background (needed for ← / →)
      listFolderImages(path).then((list) => {
        const t = this.tab(id);
        if (!t) return;
        t.folder = list;
        t.folderIndex = list.findIndex((p) => keyOf(p) === t.key);
        if (this.activeId === id) { this.updateTitle(); this.schedulePrefetch(); }
      });
    }
    if (lastId !== null) this.activate(lastId);
    return ok.length > 0;
  }

  /** Browser build: a File without a path (no folder navigation). */
  openFile(file: File) {
    const id = ++this.seq;
    this.tabs.push({
      id, key: `file:${id}`, path: null, file, name: file.name,
      folder: [], folderIndex: -1, meta: null, view: null, orient: null, guides: { v: [], h: [] }, layer: 0, layers: null, annot: new Annotations(), sel: null, lastSel: null, loading: false, error: null, token: 0,
    });
    this.activate(id);
  }

  reopenClosed() {
    const c = this.closed.pop();
    if (c) this.openPaths([c.path]);
  }

  // ---------------------------------------------------------------- tabs

  activate(id: number) {
    const prev = this.active;
    if (prev && prev.id !== id && this.renderer?.hasImage) prev.view = this.renderer.getView();
    const tab = this.tab(id);
    if (!tab) return;
    // activating the compared tab swaps A and B
    if (this.compare && prev && id === this.compare.bId && prev.id !== id) this.compare.bId = prev.id;
    this.activeId = id;
    this.mru = [id, ...this.mru.filter((x) => x !== id)];
    const entry = this.cache.get(cacheKey(tab));
    if (entry) {
      this.present(tab, entry, true);
    } else {
      this.renderer?.show(null);
      if (!tab.loading) this.loadTab(tab);
    }
    this.updateTitle();
    this.enforceCache();
    this.schedulePrefetch();
    this.syncCompare();
  }

  cycle(delta: number) {
    if (this.tabs.length < 2 || this.activeId === null) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length].id);
  }

  async close(id: number, force = false) {
    if (!force && !(await this.confirmDiscard(this.tab(id)))) return;
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    tab.token++; // cancel a pending load
    this.dropLayers(tab);
    if (tab.path) this.closed.push({ path: tab.path });
    if (this.closed.length > 20) this.closed.shift();
    this.mru = this.mru.filter((x) => x !== id);
    if (this.compare?.bId === id) this.stopCompare();
    if (this.activeId === id) {
      const next = this.tabs[i] ?? this.tabs[i - 1];
      if (next) {
        this.activeId = null; // do not save the closed tab's view into the next one
        this.activate(next.id);
      } else {
        this.activeId = null;
        this.renderer?.show(null);
        this.updateTitle();
      }
    }
    this.enforceCache();
  }

  closeActive() {
    if (this.activeId !== null) this.close(this.activeId);
  }

  // ---------------------------------------------------------------- folder navigation

  step(delta: number) {
    const tab = this.active;
    if (!tab?.path || tab.folder.length < 2) return;
    const n = tab.folder.length;
    const base = tab.folderIndex >= 0 ? tab.folderIndex : 0;
    this.goTo((base + delta + n) % n);
  }

  async goTo(index: number) {
    const tab = this.active;
    if (!tab?.path || tab.folder.length === 0) return;
    if (!(await this.confirmDiscard(tab)) || this.active !== tab) return;
    const i = Math.max(0, Math.min(tab.folder.length - 1, index));
    const path = tab.folder[i];
    tab.path = path;
    tab.key = keyOf(path);
    tab.name = baseName(path);
    tab.folderIndex = i;
    tab.layer = 0;
    tab.annot = new Annotations();
    tab.sel = null;
    tab.lastSel = null;
    this.dropLayers(tab);
    if (this.renderer?.hasImage) tab.orient = { rotation: this.renderer.rotation, flipX: this.renderer.flipX };
    tab.view = null;
    const entry = this.cache.get(cacheKey(tab));
    if (entry) {
      tab.token++; // supersede a slower load still running for the previous image
      tab.loading = false;
      tab.error = null;
      this.present(tab, entry, true);
      recent.add(path);
    } else {
      this.loadTab(tab);
    }
    this.updateTitle();
    this.enforceCache();
    this.schedulePrefetch();
  }

  /** Shows another layer (channel group) of the active EXR: decodes it again. */
  setLayer(index: number) {
    const tab = this.active;
    if (!tab || tab.layer === index) return;
    tab.layer = index;
    const view = this.renderer?.hasImage ? this.renderer.getView() : null;
    void this.reload(view); // keep zoom / position (same image size)
  }

  /** Reloads the active image from disk (drops its cached texture). `keepView`: view to restore instead of fitting. */
  async reload(keepView: ViewState | null = null) {
    const tab = this.active;
    if (!tab) return;
    if (!(await this.confirmDiscard(tab)) || this.active !== tab) return;
    const e = this.cache.get(cacheKey(tab));
    if (e) { this.cache.delete(cacheKey(tab)); this.renderer?.dispose(e.set); this.cacheVersion++; }
    if (this.renderer?.hasImage) tab.orient = { rotation: this.renderer.rotation, flipX: this.renderer.flipX };
    tab.view = keepView;
    this.dropLayers(tab);
    this.loadTab(tab);
  }

  // ---------------------------------------------------------------- loading

  private async loadTab(tab: Tab) {
    const token = ++tab.token;
    const key = cacheKey(tab);
    tab.loading = true;
    tab.error = null;
    try {
      const src: FileSource = tab.file ? new BrowserFileSource(tab.file) : await TauriFileSource.open(tab.path!);
      const entry = await this.decodeAndUpload(src, key, tab.layer);
      if (token !== tab.token) return; // superseded (navigated away / closed)
      this.present(tab, entry, false);
      if (tab.path) recent.add(tab.path);
      if (this.compare?.bId === tab.id) this.syncCompare();
    } catch (e) {
      if (token !== tab.token) return;
      tab.error = `${tab.name}: ${e instanceof Error ? e.message : String(e)}`;
      tab.meta = null;
      if (this.activeId === tab.id) this.renderer?.show(null);
      console.error(e);
    } finally {
      if (token === tab.token) tab.loading = false;
      this.enforceCache();
      if (this.activeId === tab.id) this.schedulePrefetch();
    }
  }

  /** Decodes + uploads, de-duplicating concurrent requests for the same key, and stores the result in the cache. */
  private decodeAndUpload(src: FileSource, key: string, layer = 0): Promise<CacheEntry> {
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = (async () => {
      const t0 = performance.now();
      const img = await loadImage(src, { layer });
      let up: { set: TextureSet; ms: number };
      try {
        up = await this.renderer!.upload(img.image);
      } finally {
        img.release?.(); // shared memory is no longer needed once the pixels are on the GPU
      }
      const { image: _i, release: _r, ...rest } = img;
      const entry: CacheEntry = { set: up.set, meta: { ...rest, uploadMs: up.ms, totalMs: performance.now() - t0, fromCache: false } };
      this.cache.set(key, entry);
      this.cacheVersion++;
      return entry;
    })();
    this.inflight.set(key, p);
    p.then(() => this.inflight.delete(key), () => this.inflight.delete(key));
    return p;
  }

  /** Shows a decoded image in `tab` (only draws when the tab is active). */
  private present(tab: Tab, entry: CacheEntry, fromCache: boolean) {
    tab.meta = fromCache ? { ...entry.meta, fromCache: true, totalMs: 0 } : entry.meta;
    tab.error = null;
    if (this.activeId !== tab.id || !this.renderer) return;
    this.renderer.show(entry.set);
    if (tab.view) this.renderer.setView(tab.view);
    else { this.renderer.setOrientation(tab.orient ?? { rotation: 0, flipX: false }); this.renderer.fit(); }
    const doc = this.docs.get(tab.id);
    if (tab.layers?.useLayers && doc?.output) this.renderer.show(doc.output);
    this.zoom = this.renderer.scale;
    this.updateTitle();
    this.syncCompare();
  }

  // ---------------------------------------------------------------- GPU cache / prefetch

  private neighbourPaths(tab: Tab | null): string[] {
    if (!tab?.path || tab.folder.length < 2 || tab.folderIndex < 0) return [];
    const n = tab.folder.length;
    const next = tab.folder[(tab.folderIndex + 1) % n];
    const prev = tab.folder[(tab.folderIndex - 1 + n) % n];
    return next === prev ? [next] : [next, prev];
  }

  /** Frees GPU textures that the policy does not keep. */
  private enforceCache() {
    const active = this.active;
    // priority order: active > next > previous > recently used tabs
    const keep: string[] = [];
    if (active) keep.push(cacheKey(active));
    const b = this.compareTab;
    if (b) keep.push(cacheKey(b));
    for (const p of this.neighbourPaths(active)) keep.push(keyOf(p));
    for (const id of this.mru.slice(0, KEEP_OTHER_TABS + 1)) {
      const t = this.tab(id);
      if (t && t.id !== active?.id) keep.push(cacheKey(t));
    }
    const kept = new Set<string>();
    let bytes = 0;
    for (const k of keep) {
      const e = this.cache.get(k);
      if (!e || kept.has(k)) continue;
      if (kept.size > 0 && bytes + e.set.bytes > GPU_BUDGET) continue; // over budget (the active image is always kept)
      kept.add(k);
      bytes += e.set.bytes;
    }
    let changed = false;
    for (const [k, e] of this.cache) {
      if (kept.has(k)) continue;
      if (this.renderer?.activeSet === e.set || this.renderer?.compare?.set === e.set) continue; // never free what is on screen
      this.cache.delete(k);
      this.renderer?.dispose(e.set);
      changed = true;
    }
    if (changed) this.cacheVersion++;
  }

  /** After the active image is shown, decode + upload the next / previous image of its folder in the background. */
  private schedulePrefetch() {
    const token = ++this.prefetchToken;
    const tab = this.active;
    const targets = this.neighbourPaths(tab);
    if (!targets.length) return;
    setTimeout(async () => {
      for (const path of targets) {
        if (token !== this.prefetchToken) return;
        const key = keyOf(path);
        if (this.cache.has(key) || this.inflight.has(key)) continue;
        if (this.active?.loading) return; // the visible image has priority; retried after it finished
        try {
          await this.decodeAndUpload(await TauriFileSource.open(path), key);
        } catch (e) {
          console.warn("prefetch failed", path, e);
        }
        this.enforceCache();
      }
    }, PREFETCH_DELAY_MS);
  }

  // ---------------------------------------------------------------- layers (phase 2-a, read only)

  /** Loads the layer tree of a PSD tab (whole file + decode in the worker + GPU upload). */
  async loadLayers(tab: Tab) {
    if (tab.layers || !this.renderer) return;
    const psd = isPsd(tab.name);
    // PNG / JPG / WebP: the image as shown becomes the only layer (8-bit images only)
    const flatSet = psd ? null : this.cache.get(cacheKey(tab))?.set;
    if (!psd && (!flatSet || flatSet.hdr)) return;
    const token = tab.token;
    tab.layers = {
      status: "loading", error: null, tree: [], count: 0, useLayers: false, selectedId: null, selection: [], stats: null, diff: null,
      dirty: false, undoCount: 0, redoCount: 0, saving: false, savePhase: null, saved: null, fileCount: 0, canvas: { w: 0, h: 0, ox: 0, oy: 0 },
      maskTarget: false, maskView: null,
    };
    try {
      const data = flatSet ? this.flatDoc(flatSet) : await loadLayers(tab.file ? new BrowserFileSource(tab.file) : await TauriFileSource.open(tab.path!));
      if (token !== tab.token || !tab.layers || this.tabs.indexOf(tab) < 0) return; // navigated away / closed
      this.compositor ??= new Compositor(this.renderer);
      const t0 = performance.now();
      const doc = this.compositor.upload(data);
      const uploadMs = performance.now() - t0;
      this.docs.set(tab.id, doc);
      this.compositor.render(doc);
      Object.assign(tab.layers, {
        status: "ready", tree: data.layers, count: data.count, fileCount: data.count,
        canvas: { w: data.width, h: data.height, ox: 0, oy: 0 },
        // a flat image's only layer is selected (ready to paint)
        ...(flatSet ? { selectedId: 1, selection: [1] } : {}),
        stats: { readMs: data.readMs, decodeMs: data.decodeMs, uploadMs, compositeMs: doc.lastMs, passes: doc.passes },
      });
    } catch (e) {
      if (tab.layers) Object.assign(tab.layers, { status: "error", error: e instanceof Error ? e.message : String(e) });
      console.error(e);
    }
  }

  /** Loads the layers when needed and waits until they are ready (also when a load is already running).
   *  False when the image cannot become a layer document (EXR / HDR) or loading failed. */
  async ensureLayers(tab: Tab): Promise<boolean> {
    if (!tab.layers) await this.loadLayers(tab);
    while (tab.layers?.status === "loading") await new Promise((r) => setTimeout(r, 50));
    return tab.layers?.status === "ready";
  }

  /** A layer document from a flat image: one layer ("背景" when opaque, else "レイヤー 0"), made in the app. */
  private flatDoc(set: TextureSet): PsdDocData & { readMs: number } {
    const t0 = performance.now();
    const p = this.renderer!.readSet(set); // premultiplied
    let opaque = true;
    for (let i = 3; i < p.length; i += 4) {
      const a = p[i];
      if (a === 255) continue;
      opaque = false;
      if (a) { p[i - 3] = Math.min(255, (p[i - 3] * 255) / a + 0.5); p[i - 2] = Math.min(255, (p[i - 2] * 255) / a + 0.5); p[i - 1] = Math.min(255, (p[i - 1] * 255) / a + 0.5); }
    }
    const w = set.width, h = set.height;
    const px = new Uint8ClampedArray(p.buffer, p.byteOffset, p.byteLength);
    const layer: DocLayer = {
      id: 1, origId: null, dup: false, raster: true, background: opaque, locks: 0, name: opaque ? "背景" : "レイヤー 0", kind: "pixel",
      hidden: false, opacity: 1, fill: 1, blendMode: "normal", clipping: false, x: 0, y: 0, w, h, pixels: px, mask: null, maskEdited: false,
      thumb: thumbOf(px, w, h), children: null, open: true, warnings: [],
    };
    return { width: w, height: h, bitsPerChannel: 8, layers: [layer], count: 0, decodeMs: performance.now() - t0, readMs: 0 };
  }

  /** Frees a tab's layer data (GPU) and goes back to the stored composite. */
  dropLayers(tab: Tab) {
    const doc = this.docs.get(tab.id);
    const wasShown = !!doc?.output && this.renderer?.activeSet === doc.output;
    if (doc) { this.compositor?.dispose(doc); this.docs.delete(tab.id); }
    this.histories.delete(tab.id);
    tab.layers = null;
    if (wasShown && this.activeId === tab.id) {
      const e = this.cache.get(cacheKey(tab));
      this.renderer?.show(e?.set ?? null);
    }
    if (!this.docs.size) this.compositor?.trim();
  }

  /** Shows the composite of the layers (true) or the composite stored in the file (false). */
  setUseLayers(tab: Tab, on: boolean) {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    if (!l || l.status !== "ready" || !doc) return;
    l.useLayers = on;
    if (this.activeId !== tab.id || !this.renderer) return;
    const view = this.renderer.getView();
    if (on) this.renderer.show(doc.output ?? this.compositor!.render(doc, l.tree));
    else this.renderer.show(this.cache.get(cacheKey(tab))?.set ?? null);
    this.renderer.setView(view);
    this.syncCompare();
  }

  /** A layer property changed: re-composite (once per frame) and show the layer composite. */
  layersChanged(tab: Tab) {
    const l = tab.layers;
    if (!l || l.status !== "ready") return;
    if (l.maskView !== null && !this.locate(l.tree, l.maskView)) void this.showMask(tab, null);
    l.diff = null;
    if (!l.useLayers) this.setUseLayers(tab, true);
    if (this.compositePending.has(tab.id)) return;
    this.compositePending.add(tab.id);
    requestAnimationFrame(() => {
      this.compositePending.delete(tab.id);
      const doc = this.docs.get(tab.id);
      if (!doc || !tab.layers) return;
      const c = tab.layers.canvas;
      const resized = c.w !== doc.data.width || c.h !== doc.data.height;
      if (resized) {
        // canvas size changed (or undone): a new output of the new size
        const shown = !!doc.output && this.renderer?.activeSet === doc.output;
        doc.data.width = c.w;
        doc.data.height = c.h;
        if (doc.output) { this.renderer?.dispose(doc.output); doc.output = null; }
        const out = this.compositor!.render(doc, tab.layers.tree);
        if (shown && this.activeId === tab.id && this.renderer) { this.renderer.show(out); this.renderer.fit(); this.zoom = this.renderer.scale; }
        if (tab.meta) tab.meta = { ...tab.meta, width: c.w, height: c.h };
      } else {
        this.compositor!.render(doc, tab.layers.tree);
      }
      if (tab.layers.stats) Object.assign(tab.layers.stats, { compositeMs: doc.lastMs, passes: doc.passes });
    });
  }

  /** Compares the layer composite with the composite stored in the file (both 8-bit premultiplied). */
  diffComposite(tab: Tab) {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    const stored = this.cache.get(cacheKey(tab))?.set;
    if (!l || !doc?.output || !stored || !this.renderer) return;
    if (stored.width !== doc.data.width || stored.height !== doc.data.height) return; // canvas size changed
    this.compositor!.render(doc, l.tree);
    const a = this.renderer.readSet(doc.output), b = this.renderer.readSet(stored);
    let max = 0, sum = 0, over2 = 0, over8 = 0;
    const px = a.length / 4;
    for (let i = 0; i < px; i++) {
      let m = 0;
      for (let c = 0; c < 4; c++) { const d = Math.abs(a[i * 4 + c] - b[i * 4 + c]); sum += d; if (d > m) m = d; }
      if (m > max) max = m;
      if (m > 2) over2++;
      if (m > 8) over8++;
    }
    l.diff = { max, mean: sum / (px * 4), over2: over2 / px, over8: over8 / px };
  }

  // ---------------------------------------------------------------- layer editing (phase 2-b)

  private hist(tab: Tab): History {
    let h = this.histories.get(tab.id);
    if (!h) { h = { undo: [], redo: [], lastKey: null, lastTime: 0 }; this.histories.set(tab.id, h); }
    return h;
  }

  /** Applies `mutate` to the layer tree as one undoable step. Steps with the same `key` within 1 s are merged
   *  (dragging a slider is one step). */
  edit(tab: Tab, key: string | null, mutate: (tree: DocLayer[]) => void, mergeAlways = false) {
    const l = tab.layers;
    if (!l || l.status !== "ready") return;
    const h = this.hist(tab);
    const now = performance.now();
    if (!(key && h.lastKey === key && (mergeAlways || now - h.lastTime < 1000))) {
      h.undo.push({ tree: cloneTree(l.tree), canvas: { ...l.canvas }, sel: tab.sel });
      if (h.undo.length > HISTORY_MAX) h.undo.shift();
      h.redo = [];
    }
    h.lastKey = key;
    h.lastTime = now;
    mutate(l.tree);
    if (h.undo.length >= HISTORY_MAX) this.releaseUnused(tab); // the oldest step may have dropped pixel data
    l.dirty = true;
    l.undoCount = h.undo.length;
    l.redoCount = h.redo.length;
    this.layersChanged(tab);
    if (this.activeId === tab.id) this.updateTitle();
  }

  undo(tab: Tab) { this.travel(tab, true); }
  redo(tab: Tab) { this.travel(tab, false); }
  private travel(tab: Tab, back: boolean) {
    const l = tab.layers;
    if (!l || l.status !== "ready") return;
    const h = this.hist(tab);
    const from = back ? h.undo : h.redo, to = back ? h.redo : h.undo;
    const snap = from.pop();
    if (!snap) return;
    if (this.stroke?.tab === tab) this.paintEnd();
    to.push({ tree: cloneTree(l.tree), canvas: { ...l.canvas }, sel: tab.sel, patch: snap.patch, view: snap.view ? this.marks(tab) : undefined });
    if (snap.patch) this.applyPatch(tab, snap.patch, back ? "before" : "after");
    if (snap.view) this.restoreMarks(tab, snap.view);
    l.tree = snap.tree;
    l.canvas = { ...snap.canvas };
    if (tab.sel !== snap.sel) { if (!snap.sel && tab.sel) tab.lastSel = tab.sel; tab.sel = snap.sel; }
    this.select(tab, l.selection.filter((id) => this.locate(snap.tree, id)), l.selectedId);
    h.lastKey = null;
    l.dirty = true;
    l.undoCount = h.undo.length;
    l.redoCount = h.redo.length;
    this.layersChanged(tab);
    if (this.activeId === tab.id) this.updateTitle();
  }

  /** where `id` sits: the array that holds it and its index */
  private locate(tree: DocLayer[], id: number | null): { list: DocLayer[]; index: number; node: DocLayer; parent: DocLayer | null } | null {
    if (id === null) return null;
    const visit = (list: DocLayer[], parent: DocLayer | null): ReturnType<ViewerState["locate"]> => {
      for (let i = 0; i < list.length; i++) {
        if (list[i].id === id) return { list, index: i, node: list[i], parent };
        const r = list[i].children ? visit(list[i].children!, list[i]) : null;
        if (r) return r;
      }
      return null;
    };
    return visit(tree, null);
  }

  private newLayerData(doc: LayerDoc, name: string, group: boolean): DocLayer {
    return {
      id: doc.nextId++, origId: null, dup: false, raster: false, background: false, locks: 0, name, kind: group ? "group" : "pixel", hidden: false, opacity: 1, fill: 1,
      blendMode: group ? "pass through" : "normal", clipping: false, x: 0, y: 0, w: 0, h: 0, pixels: null, mask: null, maskEdited: false,
      thumb: null, children: group ? [] : null, open: true, warnings: [],
    };
  }

  private countLayers(tree: DocLayer[]) {
    let n = 0;
    const walk = (ls: DocLayer[]) => { for (const l of ls) { n++; if (l.children) walk(l.children); } };
    walk(tree);
    return n;
  }

  /** inserts `node` above the selected layer (or at the top) and selects it */
  private insert(tab: Tab, node: DocLayer, label: string) {
    this.edit(tab, null, (tree) => {
      const at = this.locate(tree, tab.layers!.selectedId);
      if (at) at.list.splice(at.index + 1, 0, node); else tree.push(node);
    });
    this.select(tab, [node.id]);
    void label;
  }

  newLayer(tab: Tab) {
    const doc = this.docs.get(tab.id);
    if (!doc || !tab.layers) return;
    this.insert(tab, this.newLayerData(doc, `レイヤー ${this.countLayers(tab.layers.tree) + 1}`, false), "新規レイヤー");
  }

  newGroup(tab: Tab) {
    const doc = this.docs.get(tab.id);
    if (!doc || !tab.layers) return;
    this.insert(tab, this.newLayerData(doc, `グループ ${this.countLayers(tab.layers.tree) + 1}`, true), "新規グループ");
  }

  // ---------------------------------------------------------------- canvas size (phase 2-d)

  /** Ctrl+Alt+C: new canvas `w` x `h`; `anchor` 0..8 (row-major 3 x 3: where the current image stays). Layers move,
   *  their pixels do not change (outside the canvas they are kept, as in Photoshop). */
  canvasSize(tab: Tab, w: number, h: number, anchor: number): string | null {
    const l = tab.layers;
    if (!l || l.status !== "ready") return "カンバスサイズは PSD のレイヤーを読み込んだ時だけ変えられます（F7）";
    w = Math.round(w); h = Math.round(h);
    if (!(w >= 1 && h >= 1 && w <= 30000 && h <= 30000)) return "幅と高さは 1〜30000 px にしてください";
    const c = l.canvas;
    if (w === c.w && h === c.h) return null;
    const col = anchor % 3, row = Math.floor(anchor / 3);
    const dx = col === 0 ? 0 : col === 1 ? Math.round((w - c.w) / 2) : w - c.w;
    const dy = row === 0 ? 0 : row === 1 ? Math.round((h - c.h) / 2) : h - c.h;
    this.edit(tab, null, (tree) => {
      const walk = (ls: DocLayer[]) => {
        for (const x of ls) {
          x.x += dx; x.y += dy;
          if (x.mask) { x.mask.x += dx; x.mask.y += dy; }
          if (x.children) walk(x.children);
        }
      };
      walk(tree);
      l.canvas = { ...c, w, h, ox: c.ox + dx, oy: c.oy + dy };
      tab.sel = shiftSel(tab.sel, dx, dy);
    });
    return null;
  }

  // ---------------------------------------------------------------- selection

  /** Selects `ids` (the last one becomes the active layer). */
  select(tab: Tab, ids: number[], active: number | null = ids[ids.length - 1] ?? null) {
    const l = tab.layers;
    if (!l) return;
    if (active !== l.selectedId) l.maskTarget = false;
    l.selection = [...new Set(ids)];
    l.selectedId = active !== null && l.selection.includes(active) ? active : l.selection[l.selection.length - 1] ?? null;
  }

  /** the selected layers without the ones inside a selected group, bottom -> top (file order) */
  selectedRoots(tab: Tab): DocLayer[] {
    const l = tab.layers;
    if (!l) return [];
    // the active layer outside the selection (set directly) wins: the selection is stale then
    const ids = l.selectedId !== null && !l.selection.includes(l.selectedId) ? [l.selectedId] : l.selection;
    const sel = new Set(ids);
    const out: DocLayer[] = [];
    const walk = (ls: DocLayer[], inside: boolean) => {
      for (const x of ls) {
        const picked = !inside && sel.has(x.id);
        if (x.children) walk(x.children, inside || picked);
        if (picked) out.push(x); // after its children: file (post-) order
      }
    };
    walk(l.tree, false);
    return out;
  }

  private copyLayer(doc: LayerDoc, src: DocLayer): DocLayer {
    const c = { ...cloneTree([src])[0], id: doc.nextId++, dup: src.origId !== null, children: null as DocLayer[] | null };
    const g = doc.gpu.get(src.id);
    if (g) doc.gpu.set(c.id, g); // share the textures (pixels are not edited yet)
    c.children = src.children ? src.children.map((x) => this.copyLayer(doc, x)) : null;
    return c;
  }

  /** Ctrl+J: copies of the selected layers (or groups), each above its source */
  duplicate(tab: Tab) {
    const doc = this.docs.get(tab.id);
    const roots = this.selectedRoots(tab);
    if (!doc || !roots.length) return;
    const copies = roots.map((r) => ({ src: r.id, c: { ...this.copyLayer(doc, r), name: `${r.name} のコピー` } }));
    this.edit(tab, null, (tree) => {
      for (const { src, c } of copies) {
        const at = this.locate(tree, src);
        if (at) at.list.splice(at.index + 1, 0, c);
      }
    });
    this.select(tab, copies.map((x) => x.c.id));
  }

  deleteSelected(tab: Tab) {
    const l = tab.layers;
    const roots = this.selectedRoots(tab);
    if (!l || !roots.length) return;
    const gone = new Set(roots.map((r) => r.id));
    // afterwards select the layer below the lowest deleted one (or above it, or its group)
    const first = this.locate(l.tree, roots[0].id)!;
    const cand = [...first.list.slice(0, first.index).reverse(), ...first.list.slice(first.index + 1)].find((x) => !gone.has(x.id)) ?? first.parent;
    this.edit(tab, null, (tree) => {
      for (const r of roots) { const at = this.locate(tree, r.id); if (at) at.list.splice(at.index, 1); }
    });
    this.select(tab, cand && this.locate(l.tree, cand.id) ? [cand.id] : []);
  }

  /** Ctrl+G: puts the selected layers into a new group (at the place of the topmost one) */
  groupSelected(tab: Tab) {
    const doc = this.docs.get(tab.id);
    const l = tab.layers;
    const roots = this.selectedRoots(tab);
    if (!doc || !l || !roots.length) return;
    const g = this.newLayerData(doc, `グループ ${this.countLayers(l.tree) + 1}`, true);
    const top = roots[roots.length - 1];
    this.edit(tab, null, (tree) => {
      const at = this.locate(tree, top.id)!;
      at.list.splice(at.index, 1, g);
      const kids: DocLayer[] = [];
      for (const r of roots) {
        if (r.id !== top.id) { const a = this.locate(tree, r.id); if (a) a.list.splice(a.index, 1); }
        r.clipping = false;
        kids.push(r);
      }
      g.children = kids;
    });
    this.select(tab, [g.id]);
  }

  /** Moves layer `id` — or, when it is selected, all selected layers — above / below / into (top of) `target`. */
  move(tab: Tab, id: number, target: number, where: "above" | "below" | "inside") {
    const l = tab.layers;
    if (!l) return;
    const inSel = l.selection.includes(id);
    const moving = inSel ? this.selectedRoots(tab) : [this.locate(l.tree, id)?.node].filter((x): x is DocLayer => !!x);
    if (!moving.length) return;
    // not onto / into a moved layer
    for (const m of moving) {
      if (m.id === target) return;
      if (m.children && this.locate(m.children, target)) return;
    }
    this.edit(tab, null, (tree) => {
      for (const m of moving) { const a = this.locate(tree, m.id); if (a) a.list.splice(a.index, 1); }
      const t = this.locate(tree, target)!;
      if (where === "inside" && t.node.children) t.node.children.push(...moving);
      else t.list.splice(where === "above" ? t.index + 1 : t.index, 0, ...moving);
    });
  }

  /** Changes properties of all selected layers (same `key` within 1 s = one undo step). */
  updateSelected(tab: Tab, patch: Parameters<ViewerState["updateLayer"]>[2], key: string | null = null) {
    const l = tab.layers;
    if (!l) return;
    const ids = l.selectedId !== null && !l.selection.includes(l.selectedId) ? [l.selectedId] : l.selection;
    this.edit(tab, key, (tree) => {
      for (const id of ids) {
        const at = this.locate(tree, id);
        if (!at) continue;
        const { maskDisabled, ...rest } = patch;
        // groups have no fill / clipping of their own here
        const r: Partial<DocLayer> = { ...rest };
        if (at.node.children) { delete r.fill; delete r.clipping; if (r.blendMode === undefined) delete r.blendMode; }
        else if (r.blendMode === "pass through") delete r.blendMode;
        Object.assign(at.node, r);
        if (maskDisabled !== undefined && at.node.mask) at.node.mask.disabled = maskDisabled;
      }
    });
  }

  /** Eye drag: sets `hidden` of layer `id`; all calls with the same `key` are one undo step. */
  setHiddenDrag(tab: Tab, id: number, hidden: boolean, key: string) {
    this.edit(tab, key, (tree) => { const at = this.locate(tree, id); if (at) at.node.hidden = hidden; }, true);
  }

  /** Changes properties of layer `id` (same `key` within 1 s = one undo step, e.g. while dragging a slider). */
  updateLayer(tab: Tab, id: number, patch: Partial<Pick<DocLayer, "name" | "hidden" | "opacity" | "fill" | "blendMode" | "clipping" | "open" | "locks">> & { maskDisabled?: boolean }, key: string | null = null) {
    this.edit(tab, key, (tree) => {
      const at = this.locate(tree, id);
      if (!at) return;
      const { maskDisabled, ...rest } = patch;
      Object.assign(at.node, rest);
      if (maskDisabled !== undefined && at.node.mask) at.node.mask.disabled = maskDisabled;
    });
  }

  /** Ctrl+Alt+G: clipping mask on / off for the selected layer */
  toggleClipping(tab: Tab) {
    const l = tab.layers;
    const at = l && this.locate(l.tree, l.selectedId);
    if (at) this.updateLayer(tab, at.node.id, { clipping: !at.node.clipping });
  }

  // ---------------------------------------------------------------- merge / flatten / locks (phase 2-c)

  /** After a save the file's layers are numbered anew: point the undo / redo snapshots at the new numbers.
   *  Steps that need a layer which is no longer in the file (deleted before saving) cannot be restored from the
   *  new file, so they (and everything older) are dropped from the history. */
  private remapHistory(tab: Tab, savedOffset: Canvas) {
    const l = tab.layers;
    const h = this.histories.get(tab.id);
    if (!l || !h) return;
    const now = new Map<number, number>();
    const index = (ls: DocLayer[]) => { for (const x of ls) { now.set(x.id, x.origId!); if (x.children) index(x.children); } };
    index(l.tree);
    const fix = (ls: DocLayer[]): boolean => {
      let ok = true;
      for (const x of ls) {
        const o = now.get(x.id);
        if (o !== undefined) { x.origId = o; x.dup = false; x.raster = false; x.maskEdited = false; }
        // a layer of the old file that is gone (deleted, or replaced by edited pixels) cannot be found in the new one
        else if (x.origId !== null) ok = false;
        if (x.children && !fix(x.children)) ok = false;
      }
      return ok;
    };
    // newest first: the last element of each stack is the next step
    // snapshots' canvas mappings are relative to the old file; the saved file is the old one mapped by S:
    // relative to the new file a snapshot's mapping N becomes N ∘ S⁻¹
    const S = savedOffset.m ?? [1, 0, 0, 1];
    const det = S[0] * S[3] - S[1] * S[2];
    const inv = [S[3] / det, -S[1] / det, -S[2] / det, S[0] / det];
    for (const sn of [...h.undo, ...h.redo]) {
      const N = sn.canvas.m ?? [1, 0, 0, 1];
      const r: [number, number, number, number] = [N[0] * inv[0] + N[1] * inv[2], N[0] * inv[1] + N[1] * inv[3], N[2] * inv[0] + N[3] * inv[2], N[2] * inv[1] + N[3] * inv[3]];
      const ox = sn.canvas.ox - (r[0] * savedOffset.ox + r[1] * savedOffset.oy), oy = sn.canvas.oy - (r[2] * savedOffset.ox + r[3] * savedOffset.oy);
      const ident = r[0] === 1 && r[1] === 0 && r[2] === 0 && r[3] === 1;
      sn.canvas = { w: sn.canvas.w, h: sn.canvas.h, ox: Math.round(ox), oy: Math.round(oy), ...(ident ? {} : { m: r }) };
    }
    for (let i = h.undo.length - 1; i >= 0; i--) if (!fix(h.undo[i].tree)) { h.undo = h.undo.slice(i + 1); break; }
    for (let i = h.redo.length - 1; i >= 0; i--) if (!fix(h.redo[i].tree)) { h.redo = h.redo.slice(i + 1); break; }
    l.undoCount = h.undo.length;
    l.redoCount = h.redo.length;
    this.releaseUnused(tab);
  }

  /** Toggles a lock flag of layer `id` (LOCK_ALL replaces the others, as in Photoshop). */
  toggleLock(tab: Tab, id: number, flag: number) {
    const l = tab.layers;
    const at = l && this.locate(l.tree, id);
    if (!l || !at) return;
    // the active layer decides on / off; every selected layer gets the same
    const on = ((at.node.locks >>> 0) & flag) === 0;
    const ids = l.selection.includes(id) ? l.selection : [id];
    this.edit(tab, null, (tree) => {
      for (const x of ids) {
        const a = this.locate(tree, x);
        if (!a) continue;
        const cur = a.node.locks >>> 0;
        a.node.locks = (flag === LOCK_ALL ? (on ? LOCK_ALL : 0) : on ? ((cur & ~LOCK_ALL) | flag) : cur & ~flag) >>> 0;
      }
    });
  }

  /** why `nodes` (their visible parts) cannot be merged: unrendered content would be lost */
  private mergeBlocker(nodes: DocLayer[]): string | null {
    for (const n of nodes) {
      if (n.hidden) continue;
      if (n.kind === "adjustment") return `調整レイヤー「${n.name}」は合成できないため結合できません`;
      if (n.warnings.length) return `「${n.name}」: ${n.warnings[0]}。結合すると失われるため結合できません`;
      if (n.children) { const r = this.mergeBlocker(n.children); if (r) return r; }
    }
    return null;
  }

  /** Renders `layers` (bottom -> top) into a transparent buffer and returns straight RGBA cropped to the
   *  non-transparent area. `white`: composite over white (flatten), full canvas, opaque. */
  private rasterize(doc: LayerDoc, layers: DocLayer[], white = false) {
    const set = this.compositor!.renderSeparate(doc, layers);
    const p = this.renderer!.readSet(set);
    this.renderer!.dispose(set);
    const W = doc.data.width, H = doc.data.height;
    if (white) {
      for (let i = 0; i < p.length; i += 4) {
        const k = 255 - p[i + 3];
        p[i] += k; p[i + 1] += k; p[i + 2] += k; p[i + 3] = 255;
      }
      return { x: 0, y: 0, w: W, h: H, px: p };
    }
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
      const row = y * W * 4;
      for (let x = 0; x < W; x++) {
        if (p[row + x * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
      }
    }
    if (x1 < 0) return { x: 0, y: 0, w: 0, h: 0, px: new Uint8Array(0) };
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ((y + y0) * W + x + x0) * 4, d = (y * w + x) * 4;
        const a = p[s + 3];
        if (!a) continue;
        px[d] = Math.min(255, (p[s] * 255) / a + 0.5);
        px[d + 1] = Math.min(255, (p[s + 1] * 255) / a + 0.5);
        px[d + 2] = Math.min(255, (p[s + 2] * 255) / a + 0.5);
        px[d + 3] = a;
      }
    }
    return { x: x0, y: y0, w, h, px };
  }

  /** a new layer holding rasterized pixels */
  private rasterLayer(doc: LayerDoc, name: string, r: { x: number; y: number; w: number; h: number; px: Uint8Array }): DocLayer {
    const id = doc.nextId++;
    this.compositor!.setLayerPixels(doc, id, r.px, r.w, r.h);
    return {
      id, origId: null, dup: false, raster: true, background: false, locks: 0, name, kind: "pixel", hidden: false,
      opacity: 1, fill: 1, blendMode: "normal", clipping: false, x: r.x, y: r.y, w: r.w, h: r.h, pixels: null, mask: null, maskEdited: false,
      thumb: thumbOf(r.px, r.w, r.h), children: null, open: true, warnings: [],
    };
  }

  /** Frees GPU pixel data no longer reachable from the tree or the undo history. */
  private releaseUnused(tab: Tab) {
    const doc = this.docs.get(tab.id);
    const l = tab.layers;
    if (!doc || !l) return;
    const keep = new Set<number>();
    const walk = (ls: DocLayer[]) => { for (const x of ls) { keep.add(x.id); if (x.children) walk(x.children); } };
    walk(l.tree);
    const h = this.histories.get(tab.id);
    if (h) for (const t of [...h.undo, ...h.redo]) walk(t.tree);
    this.compositor!.releaseUnused(doc, keep);
  }

  /** Ctrl+E: merges the selected layer into the one below (a selected group: merges the group).
   *  Returns a message when it cannot. */
  mergeDown(tab: Tab): string | null {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    const at = l && this.locate(l.tree, l.selectedId);
    if (!l || !doc || !at) return "レイヤーを選択してください";
    if (this.selectedRoots(tab).length > 1) return this.mergeSelected(tab);
    if (at.node.children) return this.mergeGroup(tab);
    const node = at.node, lower = at.list[at.index - 1];
    if (!lower) return "下にレイヤーがありません";
    if (lower.children) return "下のレイヤーがグループのため結合できません";
    if (lower.hidden) return "下のレイヤーが非表示のため結合できません";
    if (pixelsLocked(lower) || pixelsLocked(node)) return "ロックされているレイヤーは結合できません";
    const blocked = this.mergeBlocker([lower, node]);
    if (blocked) return blocked;
    // a normal lower layer: the result looks the same as before (normal, 100 %); otherwise the result keeps the
    // lower layer's blend mode and opacity, with the upper layer merged into its content
    const keep = lower.blendMode !== "normal";
    const base: DocLayer = { ...lower, clipping: false, ...(keep ? { blendMode: "normal", opacity: 1 } : {}) };
    const r = this.rasterize(doc, [base, { ...node }]);
    const res = this.rasterLayer(doc, lower.name, r);
    res.clipping = lower.clipping;
    if (keep) { res.blendMode = lower.blendMode; res.opacity = lower.opacity; }
    this.edit(tab, null, (tree) => {
      const a = this.locate(tree, node.id)!;
      a.list.splice(a.index - 1, 2, res);
    });
    this.select(tab, [res.id]);
    this.releaseUnused(tab);
    return null;
  }

  /** Ctrl+E with several layers selected: merges them into one layer at the place of the topmost one
   *  (PS "Merge Layers"; hidden ones are discarded). */
  mergeSelected(tab: Tab): string | null {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    const roots = this.selectedRoots(tab);
    if (!l || !doc || roots.length < 2) return "結合するレイヤーを 2 つ以上選んでください";
    if (roots.some((r) => pixelsLocked(r))) return "ロックされているレイヤーは結合できません";
    const blocked = this.mergeBlocker(roots);
    if (blocked) return blocked;
    if (roots.every((r) => r.hidden)) return "選んだレイヤーがすべて非表示です";
    const top = roots[roots.length - 1];
    const list = roots.map((r) => ({ ...r, blendMode: r.children && r.blendMode === "pass through" ? "normal" as const : r.blendMode }));
    const r = this.rasterize(doc, list);
    const res = this.rasterLayer(doc, top.name, r);
    this.edit(tab, null, (tree) => {
      const at = this.locate(tree, top.id)!;
      at.list.splice(at.index, 1, res);
      for (const x of roots) { if (x.id === top.id) continue; const a = this.locate(tree, x.id); if (a) a.list.splice(a.index, 1); }
    });
    this.select(tab, [res.id]);
    this.releaseUnused(tab);
    return null;
  }

  /** merges the selected group into one layer */
  mergeGroup(tab: Tab): string | null {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    const at = l && this.locate(l.tree, l.selectedId);
    if (!l || !doc || !at?.node.children) return "グループを選択してください";
    const g = at.node;
    if (g.hidden) return "非表示のグループは結合できません";
    if (pixelsLocked(g)) return "ロックされているグループは結合できません";
    const blocked = this.mergeBlocker(g.children!);
    if (blocked) return blocked;
    const keep = !(g.blendMode === "pass through" || g.blendMode === "normal");
    const src: DocLayer = { ...g, clipping: false, blendMode: "normal", ...(keep ? { opacity: 1 } : {}) };
    const r = this.rasterize(doc, [src]);
    const res = this.rasterLayer(doc, g.name, r);
    res.clipping = g.clipping;
    if (keep) { res.blendMode = g.blendMode; res.opacity = g.opacity; }
    this.edit(tab, null, (tree) => {
      const a = this.locate(tree, g.id)!;
      a.list.splice(a.index, 1, res);
    });
    this.select(tab, [res.id]);
    this.releaseUnused(tab);
    return null;
  }

  /** Ctrl+Shift+E: merges all visible layers into one (at the lowest visible layer; hidden layers stay). */
  mergeVisible(tab: Tab): string | null {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    if (!l || !doc) return null;
    const visible = l.tree.filter((n) => !n.hidden);
    if (!visible.length) return "表示されているレイヤーがありません";
    if (visible.length === 1 && !visible[0].children) return "結合する表示レイヤーがありません";
    const blocked = this.mergeBlocker(visible);
    if (blocked) return blocked;
    const r = this.rasterize(doc, l.tree);
    const res = this.rasterLayer(doc, visible[0].name, r);
    this.edit(tab, null, (tree) => {
      const out: DocLayer[] = [];
      let placed = false;
      // hidden layers inside merged groups are kept (moved out of the group)
      const lift = (n: DocLayer) => { if (n.hidden) out.push(n); else n.children?.forEach(lift); };
      for (const n of tree) {
        if (n.hidden) { out.push(n); continue; }
        if (!placed) { out.push(res); placed = true; }
        n.children?.forEach(lift);
      }
      tree.splice(0, tree.length, ...out);
    });
    this.select(tab, [res.id]);
    this.releaseUnused(tab);
    return null;
  }

  /** Flattens the image into one opaque background layer (transparent areas become white). */
  async flatten(tab: Tab): Promise<string | null> {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    if (!l || !doc) return null;
    const blocked = this.mergeBlocker(l.tree);
    if (blocked) return blocked;
    let hidden = false;
    const walk = (ls: DocLayer[]) => { for (const x of ls) { if (x.hidden) hidden = true; else if (x.children) walk(x.children); } };
    walk(l.tree);
    if (hidden && !(await confirmDialog("非表示のレイヤーを破棄して画像を統合しますか？"))) return null;
    const r = this.rasterize(doc, l.tree, true);
    const res = this.rasterLayer(doc, "背景", r);
    res.background = true;
    this.edit(tab, null, (tree) => { tree.splice(0, tree.length, res); });
    this.select(tab, [res.id]);
    this.releaseUnused(tab);
    return null;
  }

  // ---------------------------------------------------------------- crop / rotate / stamp (2026-10, 後回し A)

  /** guides and annotations of `tab` (copies) */
  private marks(tab: Tab): ViewMarks {
    return { guides: { v: [...tab.guides.v], h: [...tab.guides.h] }, shapes: tab.annot.shapes };
  }
  private restoreMarks(tab: Tab, m: ViewMarks) {
    tab.guides.v = [...m.guides.v];
    tab.guides.h = [...m.guides.h];
    tab.annot.load(m.shapes);
  }
  /** one undo step that also moves the guides and annotations (`mapX` / `mapY`: a vertical / horizontal guide at
   *  v goes to [axis, value]; `mapPt`: an annotation point) */
  private transformStep(tab: Tab, mutate: (tree: DocLayer[]) => void,
    mapGuide: (axis: "v" | "h", v: number) => ["v" | "h", number], mapPt: (x: number, y: number) => [number, number]) {
    const before = this.marks(tab);
    this.edit(tab, null, mutate);
    const h = this.hist(tab);
    h.undo[h.undo.length - 1].view = before;
    const g: Guides = { v: [], h: [] };
    for (const axis of ["v", "h"] as const) for (const v of before.guides[axis]) { const [a, nv] = mapGuide(axis, v); g[a].push(nv); }
    tab.guides.v = g.v;
    tab.guides.h = g.h;
    tab.annot.load(before.shapes.map((s) => {
      const pts = s.pts.slice();
      for (let i = 0; i < pts.length; i += 2) [pts[i], pts[i + 1]] = mapPt(pts[i], pts[i + 1]);
      return { ...s, pts };
    }));
  }

  /** Crops the canvas to `r` (canvas px). The layers move; outside the new canvas their pixels are kept, or (with
   *  `deletePixels`) removed from pixel layers and layer masks. Returns a message when it cannot. */
  crop(tab: Tab, r: CropRect, deletePixels: boolean): string | null {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    if (!l || l.status !== "ready" || !doc) return "レイヤーが読み込まれていません";
    const c = l.canvas;
    const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y));
    const x1 = Math.min(c.w, Math.round(r.x + r.w)), y1 = Math.min(c.h, Math.round(r.y + r.h));
    if (x1 - x0 < 1 || y1 - y0 < 1) return "切り抜く範囲がありません";
    const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (rect.x === 0 && rect.y === 0 && rect.w === c.w && rect.h === c.h) return null;
    const inside = (x: number, y: number, w: number, h: number) => x >= rect.x && y >= rect.y && x + w <= rect.x + rect.w && y + h <= rect.y + rect.h;
    // pixels / masks cut to the new canvas (new ids: the old data stays for undo)
    const cut = (n: DocLayer): DocLayer => {
      let out = n;
      if (n.kind === "pixel" && n.w > 0 && !inside(n.x, n.y, n.w, n.h) && !pixelsLocked(n)) {
        const p = this.layerPixels(tab, n);
        const x = Math.max(rect.x, n.x), y = Math.max(rect.y, n.y);
        const w = Math.max(0, Math.min(rect.x + rect.w, n.x + n.w) - x), h = Math.max(0, Math.min(rect.y + rect.h, n.y + n.h) - y);
        out = this.withPixels(tab, n, w && h ? crop(p, { x, y, w, h }) : { x: 0, y: 0, w: 0, h: 0, px: new Uint8Array(0) });
      }
      const m = n.mask;
      if (m && m.w > 0 && !m.withVector && !inside(m.x, m.y, m.w, m.h)) {
        const cur = this.maskOf(tab, n);
        const x = Math.max(rect.x, m.x), y = Math.max(rect.y, m.y);
        const w = Math.max(0, Math.min(rect.x + rect.w, m.x + m.w) - x), h = Math.max(0, Math.min(rect.y + rect.h, m.y + m.h) - y);
        const g = w && h ? cropGrey(cur, { x, y, w, h }, cur.def) : { x: 0, y: 0, w: 0, h: 0, px: new Uint8Array(0) };
        out = this.withMask(tab, out, { ...g, def: cur.def }, m.disabled);
      }
      return out;
    };
    const dx = -rect.x, dy = -rect.y;
    this.transformStep(tab, (tree) => {
      const walk = (ls: DocLayer[]) => {
        for (let i = 0; i < ls.length; i++) {
          if (deletePixels && !ls[i].children) ls[i] = cut(ls[i]);
          const x = ls[i];
          x.x += dx; x.y += dy;
          if (x.mask) { x.mask.x += dx; x.mask.y += dy; }
          if (x.children) walk(x.children);
        }
      };
      walk(tree);
      l.canvas = { ...c, w: rect.w, h: rect.h, ox: c.ox + dx, oy: c.oy + dy };
      tab.sel = null;
    }, (axis, v) => [axis, axis === "v" ? v + dx : v + dy], (x, y) => [x + dx, y + dy]);
    if (deletePixels) this.releaseUnused(tab);
    return null;
  }

  /** Rotates / flips the whole document. Every layer keeps its kind (smart objects and text are not rasterized):
   *  pixels and masks (also of groups) are turned here for the display; when saving, Rust turns the file's channels
   *  and the placement of smart objects / text / vector masks (psd_save.rs `Shift`). Returns a message when it cannot. */
  transform(tab: Tab, t: DocTransform): string | null {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    if (!l || l.status !== "ready" || !doc) return "レイヤーが読み込まれていません";
    const W = l.canvas.w, H = l.canvas.h;
    const swap = t === "cw" || t === "ccw";
    const mapRect = (x: number, y: number, w: number, h: number) => {
      const [ax, ay] = mapPoint(t, x, y, W, H), [bx, by] = mapPoint(t, x + w, y + h, W, H);
      return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
    };
    // the same node turned: a new id with turned textures. "raster" / "maskEdited" stay as they are: what comes from
    // the file is turned again by Rust from the file's own data when saving
    const turned = (n: DocLayer): DocLayer => {
      const id = doc.nextId++;
      let rect = { x: n.x, y: n.y, w: n.w, h: n.h };
      let thumb = n.thumb;
      if (!n.children && n.w > 0 && n.h > 0 && doc.gpu.get(n.id)?.tex) {
        const q = transformPixels(t, this.layerPixels(tab, n), W, H, 4);
        this.compositor!.setLayerPixels(doc, id, q.px, q.w, q.h, null);
        rect = { x: q.x, y: q.y, w: q.w, h: q.h };
        thumb = thumbOf(q.px, q.w, q.h);
      } else {
        this.compositor!.setLayerPixels(doc, id, new Uint8Array(0), 0, 0, null);
        if (n.w > 0 && n.h > 0) rect = mapRect(n.x, n.y, n.w, n.h);
      }
      let mask = n.mask;
      if (n.mask) {
        const cur = this.maskOf(tab, n);
        const g = cur.w > 0 && cur.h > 0 ? transformPixels(t, cur, W, H, 1) : { x: 0, y: 0, w: 0, h: 0, px: new Uint8Array(0) };
        this.compositor!.setLayerMask(doc, id, id, g.w > 0 ? g.px : null, g.w, g.h);
        mask = { ...n.mask, x: g.x, y: g.y, w: g.w, h: g.h, pixels: null, thumb: g.w > 0 ? maskThumbOf(g.px, g.w, g.h, cur.def) : n.mask.thumb };
      }
      return { ...n, id, ...rect, thumb, mask, warnings: [...n.warnings] };
    };
    this.transformStep(tab, (tree) => {
      const walk = (ls: DocLayer[]) => {
        for (let i = 0; i < ls.length; i++) {
          if (ls[i].children) walk(ls[i].children!);
          ls[i] = turned(ls[i]);
        }
      };
      walk(tree);
      // the file -> document mapping becomes (this turn) ∘ (the mapping so far): new = M old + (tx, ty)
      const M: [number, number, number, number] = t === "cw" ? [0, -1, 1, 0] : t === "ccw" ? [0, 1, -1, 0] : t === "180" ? [-1, 0, 0, -1] : t === "fh" ? [-1, 0, 0, 1] : [1, 0, 0, -1];
      const tx = t === "cw" || t === "180" || t === "fh" ? (t === "cw" ? H : W) : 0;
      const ty = t === "ccw" ? W : t === "180" || t === "fv" ? H : 0;
      const c = l.canvas;
      const m = c.m ?? [1, 0, 0, 1];
      const nm: [number, number, number, number] = [M[0] * m[0] + M[1] * m[2], M[0] * m[1] + M[1] * m[3], M[2] * m[0] + M[3] * m[2], M[2] * m[1] + M[3] * m[3]];
      const ident = nm[0] === 1 && nm[1] === 0 && nm[2] === 0 && nm[3] === 1;
      l.canvas = {
        w: swap ? H : W, h: swap ? W : H,
        ox: M[0] * c.ox + M[1] * c.oy + tx, oy: M[2] * c.ox + M[3] * c.oy + ty,
        ...(ident ? {} : { m: nm }),
      };
      tab.sel = null;
    }, (axis, v) => {
      if (t === "cw") return axis === "v" ? ["h", v] : ["v", H - v];
      if (t === "ccw") return axis === "v" ? ["h", W - v] : ["v", v];
      if (t === "180") return [axis, axis === "v" ? W - v : H - v];
      if (t === "fh") return [axis, axis === "v" ? W - v : v];
      return [axis, axis === "h" ? H - v : v];
    }, (x, y) => mapPoint(t, x, y, W, H));
    this.releaseUnused(tab);
    return null;
  }

  /** Ctrl+Alt+Shift+E: what is visible, as one new layer "結合" at the top (the layers stay). */
  stampVisible(tab: Tab): string | null {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    if (!l || l.status !== "ready" || !doc) return "レイヤーが読み込まれていません";
    const visible = l.tree.filter((n) => !n.hidden);
    if (!visible.length) return "表示されているレイヤーがありません";
    const blocked = this.mergeBlocker(visible);
    if (blocked) return blocked.replace("結合できません", "複写結合できません");
    const r = this.rasterize(doc, l.tree);
    if (!r.w) return "表示されている画素がありません";
    const res = this.rasterLayer(doc, "結合", r);
    this.edit(tab, null, (tree) => { tree.push(res); });
    this.select(tab, [res.id]);
    return null;
  }

  // ---------------------------------------------------------------- selection (phase 3-a)

  /** canvas size of `tab` (layered: the document canvas; else the image shown) */
  canvasOf(tab: Tab): { w: number; h: number } {
    if (tab.layers?.status === "ready") return { w: tab.layers.canvas.w, h: tab.layers.canvas.h };
    return { w: tab.meta?.width ?? 0, h: tab.meta?.height ?? 0 };
  }

  /** Sets the selection. Layered documents: one undo step (not a document change by itself). */
  setSelection(tab: Tab, s: Sel | null) {
    if (s === tab.sel) return;
    const l = tab.layers;
    if (l?.status === "ready") {
      const h = this.hist(tab);
      h.undo.push({ tree: cloneTree(l.tree), canvas: { ...l.canvas }, sel: tab.sel });
      if (h.undo.length > HISTORY_MAX) h.undo.shift();
      h.redo = [];
      h.lastKey = null;
      l.undoCount = h.undo.length;
      l.redoCount = h.redo.length;
    }
    else {
      // images without layers: an undo history of the selection only
      let h = this.selHistories.get(tab.id);
      if (!h || h.key !== tab.key) { h = { key: tab.key, undo: [], redo: [] }; this.selHistories.set(tab.id, h); }
      h.undo.push(tab.sel);
      if (h.undo.length > HISTORY_MAX) h.undo.shift();
      h.redo = [];
    }
    if (!s && tab.sel) tab.lastSel = tab.sel;
    tab.sel = s;
  }

  /** undo / redo of the selection of an image without layers (false: nothing to undo) */
  travelSelection(tab: Tab, back: boolean): boolean {
    const h = this.selHistories.get(tab.id);
    if (!h || h.key !== tab.key) return false;
    const from = back ? h.undo : h.redo, to = back ? h.redo : h.undo;
    if (!from.length) return false;
    to.push(tab.sel);
    const s = from.pop()!;
    if (!s && tab.sel) tab.lastSel = tab.sel;
    tab.sel = s;
    return true;
  }

  /** a shape drawn with a selection tool (canvas px), combined with the current selection */
  selectShape(tab: Tab, tool: SelTool, pts: number[], mode: SelMode) {
    const { w: W, h: H } = this.canvasOf(tab);
    if (!W || !H) return;
    const shape = tool === "rect" ? rectSel(pts[0], pts[1], pts[2], pts[3], W, H)
      : tool === "ellipse" ? ellipseSel(pts[0], pts[1], pts[2], pts[3], W, H)
      : polySel(pts, W, H);
    this.setSelection(tab, combine(tab.sel, shape, mode));
  }

  selectAll(tab: Tab) { const c = this.canvasOf(tab); if (c.w && c.h) this.setSelection(tab, allSel(c.w, c.h)); }
  deselect(tab: Tab) { this.setSelection(tab, null); }
  reselect(tab: Tab) { if (tab.lastSel && !tab.sel) this.setSelection(tab, tab.lastSel); }
  invertSelection(tab: Tab) { const c = this.canvasOf(tab); if (c.w && c.h) this.setSelection(tab, invertSel(tab.sel, c.w, c.h)); }

  /** a layer's content at 100 % (its mask applied) as straight RGBA in canvas px */
  private soloPixels(tab: Tab, node: DocLayer) {
    const doc = this.docs.get(tab.id)!;
    return this.rasterize(doc, [{ ...node, hidden: false, opacity: 1, fill: 1, clipping: false, blendMode: "normal" }]);
  }

  /** Ctrl+click on a layer thumbnail: selection from the layer's opaque pixels */
  selectFromLayer(tab: Tab, id: number, mode: SelMode) {
    const l = tab.layers;
    const node = l && this.locate(l.tree, id)?.node;
    if (!l || l.status !== "ready" || !node) return;
    const p = this.soloPixels(tab, node);
    this.setSelection(tab, combine(tab.sel, selFromAlpha(p, l.canvas.w, l.canvas.h), mode));
  }

  /** raw pixels of a (non-group) layer, straight RGBA in canvas px (without its mask) */
  private layerPixels(tab: Tab, node: DocLayer) {
    const doc = this.docs.get(tab.id)!;
    return { x: node.x, y: node.y, w: node.w, h: node.h, px: this.compositor!.readLayerPixels(doc, node.id, node.w, node.h) };
  }

  /** why the active layer's pixels cannot be changed (null: they can) */
  private pixelBlocker(node: DocLayer | null | undefined): string | null {
    if (!node) return "レイヤーを選択してください";
    if (node.children) return "グループの画素は変更できません。レイヤーを選択してください";
    if (node.kind !== "pixel") return `「${node.name}」はピクセルレイヤーではないため変更できません（${node.kind === "smart" ? "スマートオブジェクト" : node.kind === "text" ? "テキスト" : "塗りつぶし・調整"}）`;
    if (pixelsLocked(node)) return `「${node.name}」はロックされています`;
    if ((node.locks >>> 0) & LOCK_TRANSPARENCY && !node.background) return `「${node.name}」は透明部分がロックされています`;
    return null;
  }

  /** a copy of `node` with new pixels (new id: the old pixels stay for undo; the layer mask is kept). Saved with the
   *  original layer record and these pixels. */
  private withPixels(tab: Tab, node: DocLayer, p: { x: number; y: number; w: number; h: number; px: Uint8Array }): DocLayer {
    const doc = this.docs.get(tab.id)!;
    const id = doc.nextId++;
    this.compositor!.setLayerPixels(doc, id, p.px, p.w, p.h, doc.gpu.get(node.id)?.mask ?? null);
    return { ...cloneTree([node])[0], id, raster: true, x: p.x, y: p.y, w: p.w, h: p.h, thumb: thumbOf(p.px, p.w, p.h) };
  }

  /** Ctrl+J / Ctrl+Shift+J with a selection: the selected part of the active layer as a new layer above it
   *  (`cut`: removed from the layer). Returns a message when it cannot. */
  layerViaSelection(tab: Tab, cut: boolean): string | null {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    const node = l && this.locate(l.tree, l.selectedId)?.node;
    if (!l || !doc || !tab.sel) return null;
    if (!node) return "レイヤーを選択してください";
    if (node.children) return "グループからはコピーできません";
    if (cut) { const b = this.pixelBlocker(node); if (b) return b; }
    const src = this.layerPixels(tab, node);
    const part = trim(maskPixels(src, tab.sel));
    if (!part.w) return "選択範囲に画素がありません";
    const res = this.rasterLayer(doc, `レイヤー ${this.countLayers(l.tree) + 1}`, part);
    res.blendMode = node.blendMode; res.opacity = node.opacity; res.fill = node.fill;
    const edited = cut ? this.withPixels(tab, node, { ...src, px: clearPixels(src, tab.sel, node.background) }) : null;
    this.edit(tab, null, (tree) => {
      const at = this.locate(tree, node.id)!;
      if (edited) at.list.splice(at.index, 1, edited);
      at.list.splice(at.index + 1, 0, res);
    });
    this.select(tab, [res.id]);
    return null;
  }

  /** Delete with a selection: clears the selected part of the active layer (a background layer: white) */
  clearSelection(tab: Tab): string | null {
    const l = tab.layers;
    const node = l && this.locate(l.tree, l.selectedId)?.node;
    if (!l || !tab.sel) return null;
    const b = this.pixelBlocker(node);
    if (b) return b;
    const src = this.layerPixels(tab, node!);
    const edited = this.withPixels(tab, node!, { ...src, px: clearPixels(src, tab.sel, node!.background) });
    this.edit(tab, null, (tree) => { const at = this.locate(tree, node!.id)!; at.list.splice(at.index, 1, edited); });
    this.select(tab, [edited.id]);
    return null;
  }

  /** what Ctrl+C copies: the selected part (or all) of the active layer, or of the image without layers */
  private copySource(tab: Tab): { x: number; y: number; w: number; h: number; px: Uint8Array } | string {
    const l = tab.layers;
    let src: { x: number; y: number; w: number; h: number; px: Uint8Array };
    if (l?.status === "ready") {
      const node = this.locate(l.tree, l.selectedId)?.node;
      if (!node) return "レイヤーを選択してください";
      src = node.children ? this.soloPixels(tab, node) : this.layerPixels(tab, node);
    } else {
      const set = this.renderer?.activeSet;
      if (!set || !this.renderer || this.active !== tab) return "画像がありません";
      if (set.hdr) return "EXR / HDR はコピーできません";
      const p = this.renderer.readSet(set);
      for (let i = 0; i < p.length; i += 4) {
        const a = p[i + 3];
        if (a && a < 255) for (let c = 0; c < 3; c++) p[i + c] = Math.min(255, (p[i + c] * 255) / a + 0.5);
      }
      src = { x: 0, y: 0, w: set.width, h: set.height, px: p };
    }
    const out = tab.sel ? trim(maskPixels(src, tab.sel)) : src;
    return out.w ? out : "選択範囲に画素がありません";
  }

  /** where the last copy came from (a paste of the same size goes back there) */
  private lastCopy: { x: number; y: number; w: number; h: number } | null = null;

  /** Ctrl+C / Ctrl+X: copies to the system clipboard as PNG (`cut`: also clears it from the layer) */
  async copySelection(tab: Tab, cut = false): Promise<string> {
    if (cut) { const b = this.pixelBlocker(tab.layers && this.locate(tab.layers.tree, tab.layers.selectedId)?.node); if (b || !tab.sel) return b ?? "切り取りには選択範囲が必要です"; }
    const p = this.copySource(tab);
    if (typeof p === "string") return p;
    this.lastCopy = { x: p.x, y: p.y, w: p.w, h: p.h };
    const blob = toPng(p);
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    } catch (e) {
      console.warn("navigator.clipboard.write failed, using the native clipboard", e);
      const ok = await copyImageFallback(p.w, p.h, new Uint8ClampedArray(p.px.buffer as ArrayBuffer, p.px.byteOffset, p.px.byteLength));
      if (!ok) throw e;
    }
    if (cut) { const m = this.clearSelection(tab); if (m) return m; }
    return `${cut ? "切り取り" : "コピー"}しました（${p.w} × ${p.h}）`;
  }

  /** Ctrl+V on a document with layers: the image as a new layer above the active one (where it was copied from when
   *  it has the same size, else centred) */
  async pasteAsLayer(tab: Tab, blob: Blob): Promise<string | null> {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    if (!l || l.status !== "ready" || !doc) return null;
    const d = await decode(blob);
    const px = new Uint8Array(d.px.buffer, d.px.byteOffset, d.px.byteLength);
    const c = this.lastCopy;
    const at = c && c.w === d.w && c.h === d.h ? { x: c.x, y: c.y } : { x: Math.round((l.canvas.w - d.w) / 2), y: Math.round((l.canvas.h - d.h) / 2) };
    const res = this.rasterLayer(doc, `レイヤー ${this.countLayers(l.tree) + 1}`, { ...at, w: d.w, h: d.h, px });
    this.insert(tab, res, "貼り付け");
    return `貼り付けました（${d.w} × ${d.h}）`;
  }

  // ---------------------------------------------------------------- layer masks (3-a follow-up)

  /** a layer's mask on the CPU (canvas px; empty rectangle: everything is `defaultColor`) */
  private maskOf(tab: Tab, node: DocLayer): { x: number; y: number; w: number; h: number; def: number; px: Uint8Array } {
    const m = node.mask!;
    const doc = this.docs.get(tab.id)!;
    const px = m.w > 0 && m.h > 0 ? this.compositor!.readMaskPixels(doc, node.id, m.w, m.h) : new Uint8Array(0);
    return { x: m.x, y: m.y, w: m.w, h: m.h, def: m.defaultColor, px };
  }

  /** a copy of `node` (new id) with mask `m` (null: no mask); its pixels are shared */
  private withMask(tab: Tab, node: DocLayer, m: { x: number; y: number; w: number; h: number; def: number; px: Uint8Array } | null, disabled = false): DocLayer {
    const doc = this.docs.get(tab.id)!;
    const id = doc.nextId++;
    this.compositor!.setLayerMask(doc, id, node.id, m && m.w > 0 && m.h > 0 ? m.px : null, m?.w ?? 0, m?.h ?? 0);
    return {
      ...cloneTree([node])[0], id, maskEdited: true,
      mask: m ? { x: m.x, y: m.y, w: m.w, h: m.h, defaultColor: m.def, disabled, pixels: null, thumb: maskThumbOf(m.px, m.w, m.h, m.def) } : null,
    };
  }

  private maskBlocker(node: DocLayer | null | undefined): string | null {
    if (!node) return "レイヤーを選択してください";
    if (node.children) return "グループのレイヤーマスクは未対応です";
    if (node.mask?.withVector) return "ベクトルマスクのあるレイヤーのマスクは編集できません";
    if (node.origId === null && !node.raster) return "空のレイヤーにはマスクを追加できません";
    if ((node.locks >>> 0) & LOCK_ALL) return `「${node.name}」はロックされています`;
    return null;
  }

  /** replaces the active layer with `make(node)` as one undo step and selects it */
  private replaceActive(tab: Tab, node: DocLayer, next: DocLayer, maskTarget: boolean) {
    this.edit(tab, null, (tree) => { const at = this.locate(tree, node.id)!; at.list.splice(at.index, 1, next); });
    this.select(tab, [next.id]);
    tab.layers!.maskTarget = maskTarget && !!next.mask;
    if (tab.layers!.maskView === node.id) this.showMask(tab, next.mask ? next.id : null);
  }

  /** Adds a layer mask to the active layer: from the selection (`hide`: the selection hidden), else revealing
   *  (`hide`: hiding) everything. */
  addMask(tab: Tab, hide: boolean): string | null {
    const l = tab.layers;
    const node = l && this.locate(l.tree, l.selectedId)?.node;
    const b = this.maskBlocker(node);
    if (b) return b;
    if (node!.mask) return "このレイヤーにはすでにマスクがあります";
    const s = tab.sel;
    const m = s
      ? { x: s.x, y: s.y, w: s.w, h: s.h, def: hide ? 255 : 0, px: hide ? s.m.map((v) => 255 - v) : new Uint8Array(s.m) }
      : { x: 0, y: 0, w: 0, h: 0, def: hide ? 0 : 255, px: new Uint8Array(0) };
    this.replaceActive(tab, node!, this.withMask(tab, node!, m), true);
    return null;
  }

  deleteMask(tab: Tab): string | null {
    const l = tab.layers;
    const node = l && this.locate(l.tree, l.selectedId)?.node;
    if (!node?.mask) return "マスクがありません";
    const b = this.maskBlocker(node);
    if (b) return b;
    this.replaceActive(tab, node, this.withMask(tab, node, null), false);
    return null;
  }

  /** bakes the mask into the layer's pixels (pixel layers) */
  applyMask(tab: Tab): string | null {
    const l = tab.layers;
    const node = l && this.locate(l.tree, l.selectedId)?.node;
    if (!node?.mask) return "マスクがありません";
    const b = this.maskBlocker(node) ?? this.pixelBlocker(node);
    if (b) return b;
    const m = this.maskOf(tab, node);
    const src = this.layerPixels(tab, node);
    const px = new Uint8Array(src.px);
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const cx = x + src.x - m.x, cy = y + src.y - m.y;
        const v = cx >= 0 && cy >= 0 && cx < m.w && cy < m.h ? m.px[cy * m.w + cx] : m.def;
        const i = (y * src.w + x) * 4 + 3;
        px[i] = Math.round((px[i] * v) / 255);
      }
    }
    const withPx = this.withPixels(tab, node, { ...src, px });
    const doc = this.docs.get(tab.id)!;
    const id = doc.nextId++;
    this.compositor!.setLayerMask(doc, id, withPx.id, null, 0, 0);
    this.replaceActive(tab, node, { ...withPx, id, mask: null, maskEdited: true }, false);
    return null;
  }

  /** Changes the active layer's mask: `f(value, selection value)` over the selection (or the whole mask). */
  private editMask(tab: Tab, f: (v: number, s: number) => number): string | null {
    const l = tab.layers;
    const node = l && this.locate(l.tree, l.selectedId)?.node;
    if (!node?.mask) return "マスクがありません";
    const b = this.maskBlocker(node);
    if (b) return b;
    const m = this.maskOf(tab, node);
    const c = l!.canvas;
    const s = tab.sel;
    // the new mask covers the old rectangle and the selection (an empty one: the selection only)
    const has = m.w > 0 && m.h > 0;
    const r = s ? (has ? { x0: Math.min(m.x, s.x), y0: Math.min(m.y, s.y), x1: Math.max(m.x + m.w, s.x + s.w), y1: Math.max(m.y + m.h, s.y + s.h) } : { x0: s.x, y0: s.y, x1: s.x + s.w, y1: s.y + s.h })
      : has ? { x0: m.x, y0: m.y, x1: m.x + m.w, y1: m.y + m.h } : { x0: 0, y0: 0, x1: c.w, y1: c.h };
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cx = x + r.x0, cy = y + r.y0;
        const mx = cx - m.x, my = cy - m.y;
        const v = mx >= 0 && my >= 0 && mx < m.w && my < m.h ? m.px[my * m.w + mx] : m.def;
        const sv = s ? selAt(s, cx, cy) : 255;
        px[y * w + x] = sv ? Math.round(v + (f(v, sv) - v) * (sv / 255)) : v;
      }
    }
    // outside the new rectangle: unchanged default, unless the whole mask was inverted
    const def = s ? m.def : f(m.def, 255);
    this.replaceActive(tab, node, this.withMask(tab, node, { x: r.x0, y: r.y0, w, h, def, px }, node.mask.disabled), true);
    return null;
  }

  /** Delete on the mask: hides the selected part (black) */
  hideInMask(tab: Tab) { return this.editMask(tab, () => 0); }
  /** Ctrl+I on the mask: inverts it (in the selection) */
  invertMask(tab: Tab) { return this.editMask(tab, (v) => 255 - v); }

  /** the mask (not the pixels) of the active layer is what edits act on */
  setMaskTarget(tab: Tab, on: boolean) {
    const l = tab.layers;
    const node = l && this.locate(l.tree, l.selectedId)?.node;
    if (l) l.maskTarget = on && !!node?.mask;
  }

  /** Ctrl+click on a mask thumbnail: selection from the mask */
  selectFromMask(tab: Tab, id: number, mode: SelMode) {
    const l = tab.layers;
    const node = l && this.locate(l.tree, id)?.node;
    if (!l || !node?.mask) return;
    const m = this.maskOf(tab, node);
    const W = l.canvas.w, H = l.canvas.h;
    const px = new Uint8Array(W * H).fill(m.def);
    for (let y = Math.max(0, m.y); y < Math.min(H, m.y + m.h); y++) {
      const o = y * W, r = (y - m.y) * m.w - m.x;
      for (let x = Math.max(0, m.x); x < Math.min(W, m.x + m.w); x++) px[o + x] = m.px[r + x];
    }
    this.setSelection(tab, combine(tab.sel, trimSel(new Sel(0, 0, W, H, px)), mode));
  }

  /** Alt+click on a mask thumbnail: shows the mask (grey) instead of the image; again (or null): back */
  private maskSet: TextureSet | null = null;
  async showMask(tab: Tab, id: number | null) {
    const l = tab.layers;
    if (!l || !this.renderer) return;
    if (this.maskSet) { this.renderer.dispose(this.maskSet); this.maskSet = null; }
    const node = id !== null ? this.locate(l.tree, id)?.node : null;
    if (!node?.mask) {
      l.maskView = null;
      if (this.activeId === tab.id) { const v = this.renderer.getView(); this.setUseLayers(tab, true); this.renderer.setView(v); }
      return;
    }
    l.maskView = node.id;
    const m = this.maskOf(tab, node);
    const W = l.canvas.w, H = l.canvas.h;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const mx = x - m.x, my = y - m.y;
        const v = mx >= 0 && my >= 0 && mx < m.w && my < m.h ? m.px[my * m.w + mx] : m.def;
        const o = (y * W + x) * 4;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v; rgba[o + 3] = 255;
      }
    }
    const { set } = await this.renderer.upload({ kind: "rgba", width: W, height: H, data: rgba, premultiplied: true });
    if (l.maskView !== node.id || this.activeId !== tab.id) { this.renderer.dispose(set); return; }
    this.maskSet = set;
    const v = this.renderer.getView();
    this.renderer.show(set);
    this.renderer.setView(v);
  }

  // ---------------------------------------------------------------- painting (phase 3-b)

  private painter: Painter | null = null;
  private stroke: {
    tab: Tab; nodeId: number; mask: boolean; ox: number; oy: number;
    /** last dab position (canvas px) and the distance left to the next dab */
    last: [number, number]; carry: number;
    /** the layer was replaced (expanded / unshared) at the start: the history step exists already */
    replaced: boolean;
    frame: number;
    lastRect?: Rect | null;
  } | null = null;
  /** where the last stroke ended (Shift+click draws a straight line from there) */
  private lastPaint: { tabId: number; nodeId: number; x: number; y: number } | null = null;
  private static readonly PATCH_LIMIT = 1024 * 2 ** 20;

  /** why `node` cannot be painted (null: it can) */
  private paintBlocker(node: DocLayer | null | undefined, mask: boolean): string | null {
    if (!node) return "レイヤーを選択してください";
    if (node.hidden) return `「${node.name}」は非表示のため描けません`;
    if (mask) return this.maskBlocker(node);
    if (node.children) return "グループには描けません。レイヤーを選択してください";
    if (node.kind !== "pixel") return `「${node.name}」はピクセルレイヤーではないため描けません（${node.kind === "smart" ? "スマートオブジェクト" : node.kind === "text" ? "テキスト" : "塗りつぶし・調整"}）`;
    if (pixelsLocked(node)) return `「${node.name}」はロックされています`;
    return null;
  }

  /** a texture used by another layer of the current tree (duplicates share them) */
  private sharedTexture(tab: Tab, id: number, mask: boolean): boolean {
    const doc = this.docs.get(tab.id)!;
    const g = doc.gpu.get(id);
    const t = mask ? g?.mask : g?.tex;
    if (!t) return false;
    let shared = false;
    const walk = (ls: DocLayer[]) => {
      for (const x of ls) {
        if (x.id !== id) { const o = doc.gpu.get(x.id); if (o && (mask ? o.mask : o.tex) === t) shared = true; }
        if (x.children) walk(x.children);
      }
    };
    walk(tab.layers!.tree);
    return shared;
  }

  /** Starts a brush / eraser stroke at canvas px (x, y). `line`: a straight line from the last stroke's end
   *  (Shift+click). Returns a message when it cannot. */
  paintBegin(tab: Tab, x: number, y: number, pressure: number, eraser: boolean, line: boolean): string | null {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    if (!l || l.status !== "ready" || !doc || !this.compositor) return l?.status === "loading" ? "レイヤーを準備中です" : "描くにはレイヤーを読み込んでください（F7）";
    let node = this.locate(l.tree, l.selectedId)?.node;
    const mask = l.maskTarget && !!node?.mask;
    const b = this.paintBlocker(node, mask);
    if (b) return b;
    if (l.maskView !== null) void this.showMask(tab, null);
    if (!l.useLayers) this.setUseLayers(tab, true);
    const C = { x: 0, y: 0, w: l.canvas.w, h: l.canvas.h };
    // the target must cover the canvas and must not be shared with another layer: otherwise a copy (one history step)
    let replaced = false;
    if (mask) {
      const m = node!.mask!;
      const covers = m.w > 0 && m.x <= 0 && m.y <= 0 && m.x + m.w >= C.w && m.y + m.h >= C.h;
      if (!covers || this.sharedTexture(tab, node!.id, true)) {
        const cur = this.maskOf(tab, node!);
        const x0 = cur.w ? Math.min(0, cur.x) : 0, y0 = cur.w ? Math.min(0, cur.y) : 0;
        const x1 = cur.w ? Math.max(C.w, cur.x + cur.w) : C.w, y1 = cur.w ? Math.max(C.h, cur.y + cur.h) : C.h;
        const w = x1 - x0, h = y1 - y0;
        const px = new Uint8Array(w * h).fill(cur.def);
        for (let yy = 0; yy < cur.h; yy++) px.set(cur.px.subarray(yy * cur.w, (yy + 1) * cur.w), (yy + cur.y - y0) * w + cur.x - x0);
        const next = this.withMask(tab, node!, { x: x0, y: y0, w, h, def: cur.def, px }, m.disabled);
        this.edit(tab, null, (tree) => { const at = this.locate(tree, node!.id)!; at.list.splice(at.index, 1, next); });
        this.select(tab, [next.id]);
        l.maskTarget = true;
        node = next;
        replaced = true;
      }
    } else {
      const covers = node!.w > 0 && node!.x <= 0 && node!.y <= 0 && node!.x + node!.w >= C.w && node!.y + node!.h >= C.h;
      if (!covers || this.sharedTexture(tab, node!.id, false)) {
        const src = node!.w > 0 ? this.layerPixels(tab, node!) : { x: 0, y: 0, w: 0, h: 0, px: new Uint8Array(0) };
        const x0 = src.w ? Math.min(0, src.x) : 0, y0 = src.w ? Math.min(0, src.y) : 0;
        const x1 = src.w ? Math.max(C.w, src.x + src.w) : C.w, y1 = src.w ? Math.max(C.h, src.y + src.h) : C.h;
        const big = crop(src, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
        const next = this.withPixels(tab, node!, big);
        this.edit(tab, null, (tree) => { const at = this.locate(tree, node!.id)!; at.list.splice(at.index, 1, next); });
        this.select(tab, [next.id]);
        node = next;
        replaced = true;
      }
    }
    const g = doc.gpu.get(node!.id)!;
    const tex = mask ? g.mask : g.tex;
    if (!tex) return "描画先がありません";
    const ox = mask ? node!.mask!.x : node!.x, oy = mask ? node!.mask!.y : node!.y;
    const tw = mask ? node!.mask!.w : node!.w, th = mask ? node!.mask!.h : node!.h;
    this.painter ??= new Painter(this.compositor.context);
    const keepAlpha = !mask && (node!.background || ((node!.locks >>> 0) & LOCK_TRANSPARENCY) !== 0);
    const color = hexToRgb(eraser ? paint.bg : paint.fg);
    const s = tab.sel;
    this.painter.begin(
      { tex, w: tw, h: th, mask, ox, oy },
      { color, opacity: paint.opacity, eraser: eraser && !mask, keepAlpha },
      s ? { rect: { x: s.x - ox, y: s.y - oy, w: s.w, h: s.h }, m: s.m } : null,
    );
    const from = line && this.lastPaint && this.lastPaint.tabId === tab.id && this.lastPaint.nodeId === node!.id ? this.lastPaint : null;
    this.stroke = { tab, nodeId: node!.id, mask, ox, oy, last: from ? [from.x, from.y] : [x, y], carry: 0, replaced, frame: 0 };
    if (from) this.dabLine(x, y, pressure); else this.dabAt(x, y, pressure);
    this.scheduleStrokeFrame();
    return null;
  }

  private dabAt(x: number, y: number, pressure: number) {
    const st = this.stroke!;
    const d = paint.diameter * (paint.pressureSize ? Math.max(0.05, pressure) : 1);
    const a = paint.pressureOpacity ? Math.max(0.02, pressure) : 1;
    this.painter!.dab(x - st.ox, y - st.oy, d / 2, paint.hardness, a);
  }

  /** dabs from the last position to (x, y), spaced by a quarter of the diameter */
  private dabLine(x: number, y: number, pressure: number) {
    const st = this.stroke!;
    const [x0, y0] = st.last;
    const dist = Math.hypot(x - x0, y - y0);
    const spacing = Math.max(1, paint.diameter * (paint.pressureSize ? Math.max(0.05, pressure) : 1) * 0.25);
    let t = spacing - st.carry;
    while (t <= dist) {
      this.dabAt(x0 + ((x - x0) * t) / dist, y0 + ((y - y0) * t) / dist, pressure);
      t += spacing;
    }
    st.carry = dist - (t - spacing);
    st.last = [x, y];
  }

  paintMove(x: number, y: number, pressure: number) {
    if (!this.stroke) return;
    this.dabLine(x, y, pressure);
    this.scheduleStrokeFrame();
  }

  /** writes the new dabs into the layer and re-composites that part (once per frame) */
  private scheduleStrokeFrame() {
    const st = this.stroke;
    if (!st || st.frame) return;
    st.frame = requestAnimationFrame(() => {
      if (this.stroke !== st) return;
      st.frame = 0;
      this.flushStroke(st);
    });
  }

  private flushStroke(st: NonNullable<ViewerState["stroke"]>) {
    const r = this.painter!.apply();
    const doc = this.docs.get(st.tab.id);
    if (r && doc && st.tab.layers) this.compositor!.renderRect(doc, st.tab.layers.tree, r);
  }

  paintEnd() {
    const st = this.stroke;
    if (!st) return;
    this.stroke = null;
    if (st.frame) cancelAnimationFrame(st.frame);
    const tab = st.tab, l = tab.layers, doc = this.docs.get(tab.id);
    st.lastRect = this.painter!.apply();
    const { tiles, bytes } = this.painter!.end();
    if (!l || !doc) return;
    // the last dabs (end() applied them to the layer)
    if (st.lastRect) this.compositor!.renderRect(doc, l.tree, st.lastRect);
    const node = this.locate(l.tree, st.nodeId)?.node;
    if (node && tiles.length) {
      const patch = { id: st.nodeId, mask: st.mask, tiles, bytes };
      const h = this.hist(tab);
      if (st.replaced && h.undo.length) {
        h.undo[h.undo.length - 1].patch = patch; // the copy made at the start and the stroke: one step
      } else {
        h.undo.push({ tree: cloneTree(l.tree), canvas: { ...l.canvas }, sel: tab.sel, patch });
        if (h.undo.length > HISTORY_MAX) h.undo.shift();
      }
      h.redo = [];
      h.lastKey = null;
      // keep the pixel history within its memory budget
      let total = 0;
      for (const s of h.undo) total += s.patch?.bytes ?? 0;
      while (total > ViewerState.PATCH_LIMIT && h.undo.length > 1) total -= h.undo.shift()!.patch?.bytes ?? 0;
      l.undoCount = h.undo.length;
      l.redoCount = h.redo.length;
      l.dirty = true;
      this.refreshThumb(tab, node, st.mask);
      if (this.activeId === tab.id) this.updateTitle();
    }
    this.lastPaint = { tabId: tab.id, nodeId: st.nodeId, x: st.last[0], y: st.last[1] };
  }

  /** layer / mask thumbnail after its pixels changed in place (scaled on the GPU: no full read-back) */
  private refreshThumb(tab: Tab, node: DocLayer, mask: boolean) {
    const doc = this.docs.get(tab.id)!;
    const w = mask ? node.mask?.w ?? 0 : node.w, h = mask ? node.mask?.h ?? 0 : node.h;
    if (w <= 0 || h <= 0) return;
    const k = Math.min(1, THUMB / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * k)), th = Math.max(1, Math.round(h * k));
    const data = new Uint8ClampedArray(this.compositor!.readScaled(doc, node.id, mask, w, h, tw, th).buffer);
    if (mask && node.mask) node.mask = { ...node.mask, thumb: { w: tw, h: th, data } };
    else node.thumb = { w: tw, h: th, data };
  }

  /** undo / redo of a stroke: its tiles back into the texture */
  private applyPatch(tab: Tab, p: Patch, which: "before" | "after") {
    const doc = this.docs.get(tab.id);
    const g = doc?.gpu.get(p.id);
    const tex = p.mask ? g?.mask : g?.tex;
    if (!tex || !this.compositor) return;
    applyTiles(this.compositor.context, tex, p.mask, p.tiles, which);
    const node = tab.layers && this.locate(tab.layers.tree, p.id)?.node;
    if (node) this.refreshThumb(tab, node, p.mask);
  }

  /** Alt+Delete / Ctrl+Delete: fills the selection (or everything) of the active layer / mask with the foreground /
   *  background colour */
  fillSelection(tab: Tab, which: "fg" | "bg"): string | null {
    const l = tab.layers;
    if (!l || l.status !== "ready") return "塗りつぶすにはレイヤーを読み込んでください（F7）";
    const node = this.locate(l.tree, l.selectedId)?.node;
    const color = which === "fg" ? paint.fg : paint.bg;
    const [r, g, b] = hexToRgb(color).map((v) => Math.round(v * 255));
    if (l.maskTarget && node?.mask) {
      const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      return this.editMask(tab, () => gray);
    }
    const bl = this.paintBlocker(node, false);
    if (bl) return bl;
    const C = { x: 0, y: 0, w: l.canvas.w, h: l.canvas.h };
    const src = node!.w > 0 ? this.layerPixels(tab, node!) : { x: 0, y: 0, w: 0, h: 0, px: new Uint8Array(0) };
    const x0 = src.w ? Math.min(0, src.x) : 0, y0 = src.w ? Math.min(0, src.y) : 0;
    const x1 = src.w ? Math.max(C.w, src.x + src.w) : C.w, y1 = src.w ? Math.max(C.h, src.y + src.h) : C.h;
    const big = crop(src, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    const keep = node!.background || ((node!.locks >>> 0) & LOCK_TRANSPARENCY) !== 0;
    const s = tab.sel;
    const px = big.px;
    for (let y = 0; y < big.h; y++) {
      const cy = y + big.y;
      for (let x = 0; x < big.w; x++) {
        const cx = x + big.x;
        const v = s ? selAt(s, cx, cy) : cx >= 0 && cy >= 0 && cx < C.w && cy < C.h ? 255 : 0;
        if (!v) continue;
        const i = (y * big.w + x) * 4, k = v / 255;
        const a0 = px[i + 3] / 255;
        if (keep) {
          px[i] += (r - px[i]) * k; px[i + 1] += (g - px[i + 1]) * k; px[i + 2] += (b - px[i + 2]) * k;
        } else {
          const a = k + a0 * (1 - k);
          px[i] = (r * k + px[i] * a0 * (1 - k)) / a; px[i + 1] = (g * k + px[i + 1] * a0 * (1 - k)) / a; px[i + 2] = (b * k + px[i + 2] * a0 * (1 - k)) / a;
          px[i + 3] = Math.round(a * 255);
        }
      }
    }
    this.replaceActive(tab, node!, this.withPixels(tab, node!, big), false);
    return null;
  }

  /** the colour of the image shown at canvas px (x, y) as #rrggbb (eyedropper; `size`: average of a square) */
  pickColor(x: number, y: number, size = 1): string | null {
    const r = this.renderer, set = r?.activeSet;
    if (!r || !set) return null;
    if (set.hdr) {
      const p = r.readPixel(set, x, y);
      if (!p) return null;
      const g = (v: number) => Math.pow(Math.max(0, Math.min(1, v)), 1 / 2.2) * 255;
      return rgbToHex(g(p.values[0]), g(p.values[1]), g(p.values[2]));
    }
    const v = r.readAverage(set, x, y, Math.max(1, size));
    return v ? rgbToHex(v[0], v[1], v[2]) : null;
  }

  // ---------------------------------------------------------------- AI (ComfyUI, phase D minimal)

  /** What an AI tool works on in `tab`. Background removal: the active layer (PSD with its layers loaded; the layer
   *  composite when none is selected). Edit: what is shown (the layer composite), so the model sees the context;
   *  its result goes on top. Images without layers: the image as shown. */
  aiTarget(tab: Tab, kind: WorkflowKind): { label: string; layered: boolean; layerId: number | null } {
    const l = tab.layers;
    if (l?.status === "ready") {
      const at = kind === "bg_remove" ? this.locate(l.tree, l.selectedId) : null;
      return at ? { label: `レイヤー「${at.node.name}」`, layered: true, layerId: at.node.id } : { label: "表示レイヤーの合成", layered: true, layerId: null };
    }
    return { label: isPsd(tab.name) ? "PS の統合画像（レイヤーは F7 で読み込み）" : "画像全体", layered: false, layerId: null };
  }

  /** the region the edit works on: the selection's bounds, else the rectangle annotation (the selected one, else
   *  the last one drawn); canvas px, clipped */
  aiRect(tab: Tab): Rect | null {
    if (tab.sel) {
      const c = this.canvasOf(tab), s = tab.sel;
      const x0 = Math.max(0, s.x), y0 = Math.max(0, s.y), x1 = Math.min(c.w, s.x + s.w), y1 = Math.min(c.h, s.y + s.h);
      return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    }
    const set = this.renderer?.activeSet;
    const W = tab.layers?.status === "ready" ? tab.layers.canvas.w : set?.width ?? 0;
    const H = tab.layers?.status === "ready" ? tab.layers.canvas.h : set?.height ?? 0;
    const shapes = tab.annot.shapes;
    const s = shapes.find((x) => x.id === tab.annot.selected && x.kind === "rect") ?? [...shapes].reverse().find((x) => x.kind === "rect");
    if (!s) return null;
    const [a, b, c, d] = s.pts;
    const x0 = Math.max(0, Math.round(Math.min(a, c))), y0 = Math.max(0, Math.round(Math.min(b, d)));
    const x1 = Math.min(W, Math.round(Math.max(a, c))), y1 = Math.min(H, Math.round(Math.max(b, d)));
    return x1 - x0 >= 8 && y1 - y0 >= 8 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  /** the pixels the AI tools start from (straight RGBA in canvas coordinates) */
  private aiSource(tab: Tab, layerId: number | null): Pixels & { canvas: { w: number; h: number }; node: DocLayer | null } {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    if (l?.status === "ready" && doc) {
      const canvas = { w: l.canvas.w, h: l.canvas.h };
      const node = this.locate(l.tree, layerId)?.node ?? null;
      if (!node) return { ...this.rasterize(doc, l.tree), canvas, node: null };
      // the layer's content at 100 % (its mask applied), whatever its blend mode / opacity / visibility
      const solo: DocLayer = { ...node, hidden: false, opacity: 1, fill: 1, clipping: false, blendMode: "normal" };
      return { ...this.rasterize(doc, [solo]), canvas, node };
    }
    const set = this.renderer?.activeSet;
    if (!set || !this.renderer) throw new Error("画像がありません");
    if (set.hdr) throw new Error("EXR / HDR は未対応です");
    const p = this.renderer.readSet(set); // premultiplied
    for (let i = 0; i < p.length; i += 4) {
      const a = p[i + 3];
      if (a && a < 255) { p[i] = Math.min(255, (p[i] * 255) / a + 0.5); p[i + 1] = Math.min(255, (p[i + 1] * 255) / a + 0.5); p[i + 2] = Math.min(255, (p[i + 2] * 255) / a + 0.5); }
    }
    return { x: 0, y: 0, w: set.width, h: set.height, px: p, canvas: { w: set.width, h: set.height }, node: null };
  }

  /** Runs an AI tool on the active tab through ComfyUI. The result becomes a new layer above the source layer
   *  (background removal hides the source; undo restores both), or opens in a new tab for images without layers.
   *  Returns a message for the user. */
  async runAi(
    tab: Tab, kind: WorkflowKind, opts: { prompt?: string; seed?: number },
    onProgress: (p: Progress) => void, signal: AbortSignal,
  ): Promise<string> {
    const target = this.aiTarget(tab, kind);
    const src = this.aiSource(tab, target.layerId);
    if (!src.w || !src.h) throw new Error("対象が空です（透明なレイヤー）");
    const { wf, source } = await loadWorkflow(kind);
    const stem = tab.name.replace(/\.[^.]+$/, "");
    let result: Pixels;
    let name: string;
    if (kind === "bg_remove") {
      // the model works at ~1024 px: sending more than 2048 px only costs time
      const send = fitMax(src.w, src.h, 2048);
      const png = await toPng(src, { size: send, white: true });
      const [mask] = await comfy.run(wf, png, {}, "oie_input.png", onProgress, signal);
      const m = await decode(mask, { w: src.w, h: src.h });
      const masked = applyMask(src, m.px);
      result = target.layered ? trim(masked) : masked; // a new tab keeps the image size
      if (!trim(masked).w) throw new Error("背景除去の結果が空でした（前景が見つかりません）");
      name = `${src.node?.name ?? stem} 背景除去`;
    } else {
      const prompt = (opts.prompt ?? "").trim();
      if (!prompt) throw new Error("指示（プロンプト）を入力してください");
      const sel = tab.sel;
      const rect = this.aiRect(tab);
      // without a rectangle: the whole layer (its bounds) / image
      const region = rect ? editRegion(rect, src.canvas) : { crop: { x: src.x, y: src.y, w: src.w, h: src.h }, margin: 0 };
      const area = crop(src, region.crop);
      const send = fitPixels(area.w, area.h, 1024 * 1024);
      const png = await toPng(area, { size: send, white: true });
      const [out] = await comfy.run(wf, png, { prompt, seed: opts.seed }, "oie_input.png", onProgress, signal);
      const back = await decode(out, { w: area.w, h: area.h });
      if (rect) {
        result = featheredPatch(back.px, area, rect, src.canvas);
        // a selection: its own (anti-aliased) edge instead of the feathered rectangle
        if (sel) for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) result.px[(y * rect.w + x) * 4 + 3] = selAt(sel, x + rect.x, y + rect.y);
      } else {
        const full: Pixels = { ...area, px: new Uint8Array(back.px.buffer, back.px.byteOffset, back.px.byteLength) };
        for (let i = 3; i < full.px.length; i += 4) full.px[i] = 255;
        result = full;
      }
      name = `AI 編集: ${prompt.length > 24 ? prompt.slice(0, 24) + "…" : prompt}`;
    }
    const via = source ? `（ワークフロー: ${source}）` : "";

    // layered document: a new layer
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    if (target.layered && l?.status === "ready" && doc && this.tabs.includes(tab)) {
      const res = this.rasterLayer(doc, name, result);
      const node = src.node;
      if (node) {
        res.blendMode = node.children && node.blendMode === "pass through" ? "normal" : node.blendMode;
        res.opacity = node.opacity;
        res.fill = node.children ? 1 : node.fill;
        res.clipping = node.clipping;
      }
      this.edit(tab, null, (tree) => {
        const at = node ? this.locate(tree, node.id) : null;
        if (at) {
          at.list.splice(at.index + 1, 0, res);
          if (kind === "bg_remove") at.node.hidden = true;
        } else {
          tree.push(res);
        }
      });
      this.select(tab, [res.id]);
      return `${KIND_DONE[kind]}: 新しいレイヤー「${name}」${kind === "bg_remove" && node ? "（元のレイヤーは非表示）" : ""}${via}`;
    }
    // image without layers: the result in a new tab
    const png = await toPng(kind === "bg_remove" ? result : over(src, result));
    const fname = `${stem}_${kind === "bg_remove" ? "背景除去" : "AI編集"}.png`;
    this.openFile(new File([png], fname, { type: "image/png" }));
    return `${KIND_DONE[kind]}: 新しいタブ「${fname}」（書き出しで保存）${via}`;
  }

  // ---------------------------------------------------------------- annotations

  /** Opens an image from the clipboard (pasted) in a new tab. */
  private pasteSeq = 0;
  openPasted(blob: Blob) {
    const n = ++this.pasteSeq;
    this.openFile(new File([blob], `クリップボード ${n}.png`, { type: blob.type || "image/png" }));
  }

  /** Draws the annotations into a new layer "注釈" at the top (one undo step) and removes them from the overlay.
   *  Returns a message when it cannot. */
  annotationsToLayer(tab: Tab): string | null {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    if (!l || l.status !== "ready" || !doc) return "レイヤーが読み込まれていません";
    if (!tab.annot.shapes.length) return "注釈がありません";
    const { w, h } = l.canvas; // annotations are in image px = canvas px
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d")!;
    for (const s of tab.annot.shapes) drawShape(ctx, s);
    const d = ctx.getImageData(0, 0, w, h).data; // straight alpha
    const t = trim({ x: 0, y: 0, w, h, px: new Uint8Array(d.buffer, d.byteOffset, d.byteLength) });
    tab.annot.reset();
    if (!t.w) return "注釈が画像の外にあるため、レイヤーにできませんでした";
    const node = this.rasterLayer(doc, "注釈", t);
    this.edit(tab, null, (tree) => { tree.push(node); });
    this.select(tab, [node.id]);
    return null;
  }

  /** The active tab's image as shown (layer composite or stored composite) with its annotations, as PNG. */
  private annotatedPng(): { blob: Promise<Blob>; w: number; h: number; tab: Tab } {
    const tab = this.active;
    const r = this.renderer;
    const set = r?.activeSet;
    if (!tab || !r || !set) throw new Error("画像がありません");
    if (set.hdr) throw new Error("EXR / HDR の注釈付き書き出しは未対応です");
    const px = r.readSet(set);
    return { blob: flattenToPng(px, set.width, set.height, tab.annot.shapes), w: set.width, h: set.height, tab };
  }

  /** Ctrl+Shift+C: copies the image with its annotations to the clipboard. Call from the key / click handler
   *  (the clipboard needs the user's gesture; the PNG is encoded while the write is pending). */
  async copyAnnotated(): Promise<void> {
    const { blob, w, h } = this.annotatedPng();
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    } catch (e) {
      // WebView refused (permission / no user gesture): put it on the clipboard from Rust
      console.warn("navigator.clipboard.write failed, using the native clipboard", e);
      const bmp = await createImageBitmap(await blob);
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const ok = await copyImageFallback(w, h, ctx.getImageData(0, 0, w, h).data);
      if (!ok) throw e;
    }
  }

  /** Saves the image with its annotations as PNG: next to the original as `<name>_注釈.png` (a free number is
   *  appended when it exists); images without a file (pasted) ask where. Returns the path, or null. */
  async saveAnnotatedPng(): Promise<string | null> {
    const { blob, tab } = this.annotatedPng();
    const stem = tab.name.replace(/\.[^.]+$/, "");
    let target: string | null = null;
    if (tab.path) {
      const dir = tab.path.slice(0, Math.max(tab.path.lastIndexOf("\\"), tab.path.lastIndexOf("/")) + 1);
      for (let i = 1; i < 1000 && !target; i++) {
        const p = `${dir}${stem}_注釈${i > 1 ? i : ""}.png`;
        try { await TauriFileSource.open(p); } catch { target = p; } // does not exist yet
      }
    } else {
      target = await saveDialog(`${stem}_注釈.png`, [{ name: "PNG", extensions: ["png"] }]);
    }
    const data = await (await blob).arrayBuffer();
    if (!target) {
      if (tab.path) return null;
      // browser build: download
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([data], { type: "image/png" }));
      a.download = `${stem}_注釈.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return a.download;
    }
    await writeFile(target, data, false);
    recent.add(target);
    return target;
  }

  // ---------------------------------------------------------------- export (phase 2-d)

  /** size of the image shown in the active tab (what export writes at 100 %) */
  get shownSize(): { w: number; h: number } | null {
    void this.cacheVersion;
    const set = this.renderer?.activeSet;
    return set ? { w: set.width, h: set.height } : null;
  }

  /** Writes the active tab's image as shown (layer composite or stored composite), optionally with its annotations,
   *  scaled to `w` x `h`, as PNG / JPEG / WebP. `target`: path, or null = next to the original (a free name;
   *  images without a file ask). `ask`: always choose the place. Returns the written path (browser: file name). */
  async exportImage(o: { format: "png" | "jpeg" | "webp"; quality: number; w: number; h: number; annotations: boolean; ask: boolean }): Promise<string | null> {
    const tab = this.active;
    const r = this.renderer;
    const set = r?.activeSet;
    if (!tab || !r || !set) throw new Error("画像がありません");
    if (set.hdr) throw new Error("EXR / HDR の書き出しは未対応です");
    const full = flattenToCanvas(r.readSet(set), set.width, set.height, o.annotations ? tab.annot.shapes : []);
    const w = Math.max(1, Math.round(o.w)), h = Math.max(1, Math.round(o.h));
    const out = new OffscreenCanvas(w, h);
    const ctx = out.getContext("2d")!;
    if (o.format === "jpeg") { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h); } // no transparency in JPEG
    if (w === set.width && h === set.height) {
      ctx.drawImage(full, 0, 0);
    } else {
      const bmp = await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
    }
    const blob = await out.convertToBlob({ type: `image/${o.format}`, quality: o.format === "png" ? undefined : o.quality });
    const ext = o.format === "jpeg" ? "jpg" : o.format;
    const stem = tab.name.replace(/\.[^.]+$/, "") + (w !== set.width || h !== set.height ? `_${w}x${h}` : "");
    const data = await blob.arrayBuffer();
    let target: string | null = null;
    if (tab.path && !o.ask) {
      const dir = tab.path.slice(0, Math.max(tab.path.lastIndexOf("\\"), tab.path.lastIndexOf("/")) + 1);
      for (let i = 1; i < 1000 && !target; i++) {
        const p = `${dir}${stem}${i > 1 ? ` (${i})` : ""}.${ext}`;
        try { await TauriFileSource.open(p); } catch { target = p; } // does not exist yet
      }
    } else {
      const dir = tab.path ? tab.path.slice(0, Math.max(tab.path.lastIndexOf("\\"), tab.path.lastIndexOf("/")) + 1) : "";
      target = await saveDialog(`${dir}${stem}.${ext}`, [{ name: ext.toUpperCase(), extensions: [ext] }]);
      if (!target && tab.path) return null;
    }
    if (!target) {
      // browser build: download
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([data], { type: blob.type }));
      a.download = `${stem}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return a.download;
    }
    await writeFile(target, data, false);
    return target;
  }

  hasUnsaved(): boolean { return this.tabs.some((t) => t.layers?.dirty); }

  /** Asks before discarding unsaved layer edits of `tab`. */
  async confirmDiscard(tab: Tab | null): Promise<boolean> {
    if (!tab?.layers?.dirty) return true;
    return confirmDialog(`「${tab.name}」のレイヤーの変更は保存されていません。破棄しますか？`);
  }

  /** Encodes the layer tree as a PSD / PSB: layers come from the original file (re-read), the composite from the GPU. */
  async encode(tab: Tab, psb = false): Promise<ArrayBuffer> {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    if (!l || l.status !== "ready" || !doc || !this.renderer) throw new Error("レイヤーが読み込まれていません");
    let t = performance.now();
    const phase = (name: string) => {
      const now = performance.now();
      console.info(`[save] ${l.savePhase ?? "start"}: ${(now - t).toFixed(0)} ms`);
      t = now;
      l.savePhase = name;
    };
    phase("統合画像");
    // composite (premultiplied on the GPU) -> straight RGBA for the file
    const set = this.compositor!.render(doc, l.tree);
    const px = this.renderer.readSet(set);
    const composite = new Uint8ClampedArray(px.length);
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      if (a === 0) continue;
      composite[i] = (px[i] * 255) / a + 0.5;
      composite[i + 1] = (px[i + 1] * 255) / a + 0.5;
      composite[i + 2] = (px[i + 2] * 255) / a + 0.5;
      composite[i + 3] = a;
    }
    phase("元ファイルの読み込み");
    const src: FileSource = tab.file ? new BrowserFileSource(tab.file) : await TauriFileSource.open(tab.path!);
    const original = await src.readAll();
    phase("PSD の組み立て");
    const { buffer } = await buildPsd(original, tab.name, {
      plan: toPlan(l.tree), composite, width: doc.data.width, height: doc.data.height, psb,
    });
    phase("書き込み");
    return buffer;
  }

  /** Request for the Rust saver: the edit plan and the GPU composite (premultiplied RGBA). */
  saveRequest(tab: Tab, src: string, dst: string, backup: boolean) {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    if (!l || l.status !== "ready" || !doc || !this.renderer) throw new Error("レイヤーが読み込まれていません");
    const set = this.compositor!.render(doc, l.tree);
    const composite = this.renderer.readSet(set);
    const plan = toPlan(l.tree);
    // pixels of layers made in the app, read back from their textures
    const blobs: Uint8Array[] = [];
    let offset = 0;
    const byId = new Map<number, DocLayer>();
    const walk = (ls: DocLayer[]) => { for (const x of ls) { byId.set(x.id, x); if (x.children) walk(x.children); } };
    walk(l.tree);
    const attach = (ns: PlanNode[]) => {
      for (const n of ns as (PlanNode & { pixels?: unknown })[]) {
        if (n.raster) {
          const d = byId.get(n.id)!;
          // painted layers cover the canvas: their transparent border is not written
          const t = trim({ x: d.x, y: d.y, w: d.w, h: d.h, px: this.compositor!.readLayerPixels(doc, d.id, d.w, d.h) });
          n.pixels = { offset, x: t.x, y: t.y, w: t.w, h: t.h };
          blobs.push(t.px);
          offset += t.px.length;
        }
        if (n.maskEdited) {
          const d = byId.get(n.id)!;
          if (d.mask) {
            const m = d.mask;
            const px = m.w > 0 && m.h > 0 ? this.compositor!.readMaskPixels(doc, d.id, m.w, m.h) : new Uint8Array(0);
            (n as PlanNode & { maskPixels?: unknown }).maskPixels = { offset, x: m.x, y: m.y, w: m.w, h: m.h, defaultColor: m.defaultColor, disabled: m.disabled };
            blobs.push(px);
            offset += px.length;
          }
        }
        if (n.children) attach(n.children);
      }
    };
    attach(plan);
    const req = {
      src, dst, backup, width: doc.data.width, height: doc.data.height, layerCount: l.fileCount, plan,
      offsetX: l.canvas.ox, offsetY: l.canvas.oy, xform: l.canvas.m ?? null,
    };
    const rgba = new Uint8Array(composite.length + offset);
    rgba.set(composite, 0);
    let o = composite.length;
    for (const b of blobs) { rgba.set(b, o); o += b.length; }
    return { req, rgba };
  }

  /** Writes the layer composite as PNG / JPEG / WebP to `target` (the first overwrite of a file keeps a .bak). */
  private async saveFlat(tab: Tab, target: string): Promise<boolean> {
    const l = tab.layers!;
    const doc = this.docs.get(tab.id)!;
    l.saving = true;
    l.savePhase = "書き出し";
    try {
      const t0 = performance.now();
      const set = this.compositor!.render(doc, l.tree);
      const p = this.renderer!.readSet(set);
      const ext = target.split(".").pop()!.toLowerCase();
      const type = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
      for (let i = 0; i < p.length; i += 4) {
        const a = p[i + 3];
        if (type === "image/jpeg") { const k = 255 - a; p[i] += k; p[i + 1] += k; p[i + 2] += k; p[i + 3] = 255; } // on white
        else if (a && a < 255) for (let c = 0; c < 3; c++) p[i + c] = Math.min(255, (p[i + c] * 255) / a + 0.5);
      }
      const c = new OffscreenCanvas(set.width, set.height);
      c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.buffer as ArrayBuffer, p.byteOffset, p.byteLength), set.width, set.height), 0, 0);
      const blob = await c.convertToBlob({ type, quality: type === "image/png" ? undefined : 0.95 });
      const data = await blob.arrayBuffer();
      const same = !!tab.path && keyOf(target) === keyOf(tab.path);
      const backup = same && !this.backedUp.has(keyOf(target));
      await writeFile(target, data, backup);
      if (backup) this.backedUp.add(keyOf(target));
      l.dirty = false;
      l.saved = { ms: performance.now() - t0, bytes: data.byteLength, path: target };
      const old = this.cache.get(cacheKey(tab)); // under the old key
      if (!same) {
        if (old) this.cache.delete(cacheKey(tab));
        tab.path = target; tab.key = keyOf(target); tab.name = baseName(target); tab.file = null; recent.add(target);
      }
      if (old && this.renderer!.activeSet !== old.set) { this.cache.delete(cacheKey(tab)); this.renderer!.dispose(old.set); this.cacheVersion++; }
      else if (old && !same) this.cache.set(cacheKey(tab), old);
      void TauriFileSource.open(target).then((src) => this.decodeAndUpload(src, cacheKey(tab)))
        .then((e) => { tab.meta = { ...e.meta, fromCache: true, totalMs: 0 }; this.enforceCache(); })
        .catch((e) => console.warn("re-reading the saved image failed", e));
      this.updateTitle();
      return true;
    } finally {
      l.saving = false;
      l.savePhase = null;
    }
  }

  /** things the compositor does not draw (they are missing from the composite written to the file) */
  private unrendered(tree: DocLayer[]): string[] {
    const out = new Set<string>();
    const walk = (ls: DocLayer[]) => { for (const x of ls) { if (!x.hidden) x.warnings.forEach((w) => out.add(w.replace(/（.*$/, ""))); if (x.children) walk(x.children); } };
    walk(tree);
    return [...out];
  }

  /** Saves the edited layer tree as PSD (Ctrl+S) or under a new name (saveAs).
   *  Browser build: downloads the file instead. */
  async save(tab: Tab, saveAs = false): Promise<boolean> {
    const l = tab.layers;
    if (!l || l.status !== "ready" || !this.renderer || l.saving) return false;
    let target: string | null = tab.path;
    const flatSource = !isPsd(tab.name);
    if (!tab.path && isTauri()) {
      // a pasted image (no file yet): always ask where and in which format
      target = await saveDialog(`${tab.name.replace(/\.[^.]+$/, "")}.png`, [
        { name: "PNG", extensions: ["png"] }, { name: "Photoshop（レイヤーを保持）", extensions: ["psd", "psb"] },
        { name: "JPEG", extensions: ["jpg", "jpeg"] }, { name: "WebP", extensions: ["webp"] },
      ]);
      if (!target) return false;
      if (!isPsd(target)) return this.saveFlat(tab, target);
    } else if (flatSource && tab.path) {
      // a PNG / JPG / WebP opened as a layered document
      const dir = tab.path.slice(0, Math.max(tab.path.lastIndexOf("\\"), tab.path.lastIndexOf("/")) + 1);
      const stem = tab.name.replace(/\.[^.]+$/, "");
      if (saveAs) {
        target = await saveDialog(`${dir}${stem}.psd`, [
          { name: "Photoshop（レイヤーを保持）", extensions: ["psd", "psb"] }, { name: "PNG", extensions: ["png"] },
          { name: "JPEG", extensions: ["jpg", "jpeg"] }, { name: "WebP", extensions: ["webp"] },
        ]);
        if (!target) return false;
      } else if (this.countLayers(l.tree) > 1 && !(await confirmDialog(
        `「${tab.name}」に上書きすると、レイヤーは統合されます（レイヤーを残すには Ctrl+Shift+S で PSD として保存）。統合して上書きしますか？`,
      ))) return false;
      if (!isPsd(target!)) return this.saveFlat(tab, target!);
    } else if (tab.path && saveAs) target = await saveDialog(tab.path);
    if (tab.path && !target) return false;
    const missing = this.unrendered(l.tree);
    if (missing.length && !this.warnedUnrendered.has(tab.id) && !(await confirmDialog(
      `次の要素は統合画像に反映されません（レイヤー自体はそのまま保存され、Photoshop で開けば正しく表示されます）:\n\n・${missing.join("\n・")}\n\n保存しますか？`,
    ))) return false;
    this.warnedUnrendered.add(tab.id);
    l.saving = true;
    try {
      const t0 = performance.now();
      if (!target) {
        // browser build: ag-psd in the worker, then download
        const buffer = await this.encode(tab, /\.psb$/i.test(tab.name));
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([buffer]));
        a.download = tab.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        l.saved = { ms: performance.now() - t0, bytes: buffer.byteLength, path: tab.name };
        return true;
      }
      const sameFile = !!tab.path && keyOf(target) === keyOf(tab.path);
      const backup = sameFile && !this.backedUp.has(keyOf(target));
      // desktop: Rust rebuilds the layer records and copies the layers' pixel data from the original file
      l.savePhase = "統合画像";
      const { req, rgba } = this.saveRequest(tab, tab.path ?? "", target, backup); // no source (pasted): Rust starts from a blank PSD
      l.savePhase = "書き込み";
      const r = await savePsd(req, rgba);
      console.info(`[save] total ${(performance.now() - t0).toFixed(0)} ms; Rust ${r.ms.toFixed(0)} ms (parse ${r.parseMs.toFixed(0)}, composite ${r.compositeMs.toFixed(0)}, write ${r.writeMs.toFixed(0)}), ${(r.bytes / 2 ** 20).toFixed(0)} MB`);
      const buffer = { byteLength: r.bytes };
      if (backup) this.backedUp.add(keyOf(target));
      // the file now holds exactly this tree: renumber the source ids the way the worker reads them (post-order)
      let n = 0;
      const renumber = (ls: DocLayer[]) => { for (const x of ls) { if (x.children) renumber(x.children); x.origId = ++n; x.dup = false; x.raster = false; x.background = false; x.maskEdited = false; } };
      // a flattened image is saved without layer records: its background stays a layer made in the app
      const flat = l.tree.length === 1 && l.tree[0].background && !l.tree[0].children;
      if (flat) { l.tree[0].origId = null; l.tree[0].raster = true; } else renumber(l.tree);
      l.fileCount = n;
      this.remapHistory(tab, l.canvas);
      l.canvas = { w: l.canvas.w, h: l.canvas.h, ox: 0, oy: 0 };
      l.dirty = false;
      l.saved = { ms: performance.now() - t0, bytes: buffer.byteLength, path: target };
      const old = this.cache.get(cacheKey(tab)); // under the old key
      if (!sameFile) {
        if (old) this.cache.delete(cacheKey(tab));
        tab.path = target;
        tab.key = keyOf(target);
        tab.name = baseName(target);
        tab.file = null;
        recent.add(target);
      }
      if (!l.useLayers) this.setUseLayers(tab, true);
      if (old && this.renderer.activeSet !== old.set) { this.cache.delete(cacheKey(tab)); this.renderer.dispose(old.set); this.cacheVersion++; }
      else if (old && !sameFile) this.cache.set(cacheKey(tab), old); // still shown: keep it under the new key
      // read the new file's composite in the background (for "PS の統合画像" / compare / tab switching)
      void TauriFileSource.open(target).then((src) => this.decodeAndUpload(src, cacheKey(tab)))
        .then((e) => { tab.meta = { ...e.meta, fromCache: true, totalMs: 0 }; this.enforceCache(); })
        .catch((e) => console.warn("re-reading the saved composite failed", e));
      this.updateTitle();
      return true;
    } finally {
      l.saving = false;
      l.savePhase = null;
    }
  }

  // ---------------------------------------------------------------- compare

  /** Compares the active tab with tab `bId` (default: the previously viewed tab, or the same image when there is only one). */
  startCompare(bId?: number) {
    const a = this.active;
    if (!a) return;
    const id = bId ?? this.mru.find((x) => x !== a.id && this.tab(x)) ?? a.id;
    this.compare = {
      bId: id, mode: viewOptions.compareMode, linked: viewOptions.compareLinked, fitB: viewOptions.compareFitB,
      split: 0.5, showB: false,
    };
    this.enforceCache();
    this.syncCompare();
  }

  stopCompare() {
    this.compare = null;
    this.renderer?.setCompare(null);
    this.enforceCache();
  }

  toggleCompare() {
    if (this.compare) this.stopCompare();
    else this.startCompare();
  }

  /** Changes compare settings (mode / linked / fitB are remembered for the next comparison). */
  updateCompare(patch: Partial<Compare>) {
    const c = this.compare;
    if (!c) return;
    Object.assign(c, patch);
    if (patch.mode) viewOptions.compareMode = patch.mode;
    if (patch.linked !== undefined) viewOptions.compareLinked = patch.linked;
    if (patch.fitB !== undefined) viewOptions.compareFitB = patch.fitB;
    if (patch.bId !== undefined) this.enforceCache();
    this.syncCompare();
  }

  /** Pushes the compare state to the renderer, loading image B first when its texture is not on the GPU. */
  syncCompare() {
    const c = this.compare, r = this.renderer;
    if (!c || !r) return;
    const b = this.tab(c.bId);
    if (!b) { this.stopCompare(); return; }
    const entry = this.cache.get(cacheKey(b));
    if (entry && r.hasImage) {
      r.setCompare({ set: entry.set, mode: c.mode, linked: c.linked, fitB: c.fitB, split: c.split, showB: c.showB });
    } else {
      r.setCompare(null);
      if (!entry && !b.loading) this.loadTab(b);
    }
  }

  // ---------------------------------------------------------------- misc

  updateTitle() {
    const t = this.active;
    if (!t) { setWindowTitle("OptImageEditor"); return; }
    const pos = t.folder.length && t.folderIndex >= 0 ? ` (${t.folderIndex + 1}/${t.folder.length})` : "";
    setWindowTitle(`${t.layers?.dirty ? "● " : ""}${t.name}${pos} — OptImageEditor`);
  }
}
