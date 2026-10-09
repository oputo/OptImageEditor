// Viewer state: tabs, per-tab folder navigation, GPU texture cache and prefetch of neighbour images.
//
// GPU cache policy (phase 1-b): keep textures only for
//   1. the active tab, 2. the next / previous image in the active tab's folder (prefetched),
//   3. the two most recently used other tabs.
//   (while comparing, image B is kept right after the active image)
// Everything else is freed; a tab whose texture was freed is decoded again when activated (~0.2 s).
import { buildPsd, isPsd, loadImage, loadLayers, SUPPORTED_EXT, type LoadedImage } from "./loader";
import { Compositor, type LayerDoc } from "./compositor";
import { LOCK_ALL, cloneTree, pixelsLocked, thumbOf, toPlan, type DocLayer, type PlanNode } from "./psdDoc";
import type { CompareMode, Orientation, Renderer, TextureSet, ViewState } from "./renderer";
import { viewOptions } from "./viewOptions.svelte";
import { BrowserFileSource, TauriFileSource, baseName, type FileSource } from "./source";
import { confirmDialog, copyImageFallback, listFolderImages, savePsd, saveDialog, setWindowTitle, writeFile } from "./desktop";
import { recent } from "./recent.svelte";
import { Annotations, flattenToPng } from "./annotations.svelte";

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
};

/** Undo history of a tab's layer tree (snapshots of the tree; pixels are not edited in 2-b). */
type History = { undo: DocLayer[][]; redo: DocLayer[][]; lastKey: string | null; lastTime: number };
const HISTORY_MAX = 100;

/** Comparison of the active tab (A) with tab `bId` (B; may be the same tab). */
export type Compare = { bId: number; mode: CompareMode; linked: boolean; fitB: boolean; split: number; showB: boolean };

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
        folder: [], folderIndex: -1, meta: null, view: null, orient: null, guides: { v: [], h: [] }, layer: 0, layers: null, annot: new Annotations(), loading: false, error: null, token: 0,
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
      folder: [], folderIndex: -1, meta: null, view: null, orient: null, guides: { v: [], h: [] }, layer: 0, layers: null, annot: new Annotations(), loading: false, error: null, token: 0,
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
    if (tab.layers || !this.renderer || !isPsd(tab.name)) return;
    const token = tab.token;
    tab.layers = {
      status: "loading", error: null, tree: [], count: 0, useLayers: false, selectedId: null, selection: [], stats: null, diff: null,
      dirty: false, undoCount: 0, redoCount: 0, saving: false, savePhase: null, saved: null, fileCount: 0,
    };
    try {
      const src: FileSource = tab.file ? new BrowserFileSource(tab.file) : await TauriFileSource.open(tab.path!);
      const data = await loadLayers(src);
      if (token !== tab.token || !tab.layers || this.tabs.indexOf(tab) < 0) return; // navigated away / closed
      this.compositor ??= new Compositor(this.renderer);
      const t0 = performance.now();
      const doc = this.compositor.upload(data);
      const uploadMs = performance.now() - t0;
      this.docs.set(tab.id, doc);
      this.compositor.render(doc);
      Object.assign(tab.layers, {
        status: "ready", tree: data.layers, count: data.count, fileCount: data.count,
        stats: { readMs: data.readMs, decodeMs: data.decodeMs, uploadMs, compositeMs: doc.lastMs, passes: doc.passes },
      });
    } catch (e) {
      if (tab.layers) Object.assign(tab.layers, { status: "error", error: e instanceof Error ? e.message : String(e) });
      console.error(e);
    }
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
    l.diff = null;
    if (!l.useLayers) this.setUseLayers(tab, true);
    if (this.compositePending.has(tab.id)) return;
    this.compositePending.add(tab.id);
    requestAnimationFrame(() => {
      this.compositePending.delete(tab.id);
      const doc = this.docs.get(tab.id);
      if (!doc || !tab.layers) return;
      this.compositor!.render(doc, tab.layers.tree);
      if (tab.layers.stats) Object.assign(tab.layers.stats, { compositeMs: doc.lastMs, passes: doc.passes });
    });
  }

  /** Compares the layer composite with the composite stored in the file (both 8-bit premultiplied). */
  diffComposite(tab: Tab) {
    const l = tab.layers;
    const doc = this.docs.get(tab.id);
    const stored = this.cache.get(cacheKey(tab))?.set;
    if (!l || !doc?.output || !stored || !this.renderer) return;
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
      h.undo.push(cloneTree(l.tree));
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
    to.push(cloneTree(l.tree));
    l.tree = snap;
    this.select(tab, l.selection.filter((id) => this.locate(snap, id)), l.selectedId);
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
      blendMode: group ? "pass through" : "normal", clipping: false, x: 0, y: 0, w: 0, h: 0, pixels: null, mask: null,
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

  // ---------------------------------------------------------------- selection

  /** Selects `ids` (the last one becomes the active layer). */
  select(tab: Tab, ids: number[], active: number | null = ids[ids.length - 1] ?? null) {
    const l = tab.layers;
    if (!l) return;
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
  private remapHistory(tab: Tab) {
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
        if (o !== undefined) { x.origId = o; x.dup = false; x.raster = false; }
        else if (!(x.raster || x.origId === null)) ok = false;
        if (x.children && !fix(x.children)) ok = false;
      }
      return ok;
    };
    // newest first: the last element of each stack is the next step
    for (let i = h.undo.length - 1; i >= 0; i--) if (!fix(h.undo[i])) { h.undo = h.undo.slice(i + 1); break; }
    for (let i = h.redo.length - 1; i >= 0; i--) if (!fix(h.redo[i])) { h.redo = h.redo.slice(i + 1); break; }
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
      opacity: 1, fill: 1, blendMode: "normal", clipping: false, x: r.x, y: r.y, w: r.w, h: r.h, pixels: null, mask: null,
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
    if (h) for (const t of [...h.undo, ...h.redo]) walk(t);
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

  // ---------------------------------------------------------------- annotations

  /** Opens an image from the clipboard (pasted) in a new tab. */
  private pasteSeq = 0;
  openPasted(blob: Blob) {
    const n = ++this.pasteSeq;
    this.openFile(new File([blob], `クリップボード ${n}.png`, { type: blob.type || "image/png" }));
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
          const px = this.compositor!.readLayerPixels(doc, d.id, d.w, d.h);
          n.pixels = { offset, x: d.x, y: d.y, w: d.w, h: d.h };
          blobs.push(px);
          offset += px.length;
        }
        if (n.children) attach(n.children);
      }
    };
    attach(plan);
    const req = { src, dst, backup, width: doc.data.width, height: doc.data.height, layerCount: l.fileCount, plan };
    const rgba = new Uint8Array(composite.length + offset);
    rgba.set(composite, 0);
    let o = composite.length;
    for (const b of blobs) { rgba.set(b, o); o += b.length; }
    return { req, rgba };
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
    if (tab.path && saveAs) target = await saveDialog(tab.path);
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
      const sameFile = keyOf(target) === keyOf(tab.path!);
      const backup = sameFile && !this.backedUp.has(keyOf(target));
      // desktop: Rust rebuilds the layer records and copies the layers' pixel data from the original file
      l.savePhase = "統合画像";
      const { req, rgba } = this.saveRequest(tab, tab.path!, target, backup);
      l.savePhase = "書き込み";
      const r = await savePsd(req, rgba);
      console.info(`[save] total ${(performance.now() - t0).toFixed(0)} ms; Rust ${r.ms.toFixed(0)} ms (parse ${r.parseMs.toFixed(0)}, composite ${r.compositeMs.toFixed(0)}, write ${r.writeMs.toFixed(0)}), ${(r.bytes / 2 ** 20).toFixed(0)} MB`);
      const buffer = { byteLength: r.bytes };
      if (backup) this.backedUp.add(keyOf(target));
      // the file now holds exactly this tree: renumber the source ids the way the worker reads them (post-order)
      let n = 0;
      const renumber = (ls: DocLayer[]) => { for (const x of ls) { if (x.children) renumber(x.children); x.origId = ++n; x.dup = false; x.raster = false; x.background = false; } };
      // a flattened image is saved without layer records: its background stays a layer made in the app
      const flat = l.tree.length === 1 && l.tree[0].background && !l.tree[0].children;
      if (flat) { l.tree[0].origId = null; l.tree[0].raster = true; } else renumber(l.tree);
      l.fileCount = n;
      this.remapHistory(tab);
      l.dirty = false;
      l.saved = { ms: performance.now() - t0, bytes: buffer.byteLength, path: target };
      if (!sameFile) {
        tab.path = target;
        tab.key = keyOf(target);
        tab.name = baseName(target);
        recent.add(target);
      }
      if (!l.useLayers) this.setUseLayers(tab, true);
      const old = this.cache.get(cacheKey(tab));
      if (old && this.renderer.activeSet !== old.set) { this.cache.delete(cacheKey(tab)); this.renderer.dispose(old.set); this.cacheVersion++; }
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
