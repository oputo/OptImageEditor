// Viewer state: tabs, per-tab folder navigation, GPU texture cache and prefetch of neighbour images.
//
// GPU cache policy (phase 1-b): keep textures only for
//   1. the active tab, 2. the next / previous image in the active tab's folder (prefetched),
//   3. the two most recently used other tabs.
//   (while comparing, image B is kept right after the active image)
// Everything else is freed; a tab whose texture was freed is decoded again when activated (~0.2 s).
import { buildPsd, isPsd, loadImage, loadLayers, SUPPORTED_EXT, type LoadedImage } from "./loader";
import { Compositor, type LayerDoc } from "./compositor";
import { cloneTree, toPlan, type DocLayer } from "./psdDoc";
import type { CompareMode, Orientation, Renderer, TextureSet, ViewState } from "./renderer";
import { viewOptions } from "./viewOptions.svelte";
import { BrowserFileSource, TauriFileSource, baseName, type FileSource } from "./source";
import { confirmDialog, listFolderImages, savePsd, saveDialog, setWindowTitle } from "./desktop";
import { recent } from "./recent.svelte";

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
  selectedId: number | null;
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
        folder: [], folderIndex: -1, meta: null, view: null, orient: null, guides: { v: [], h: [] }, layer: 0, layers: null, loading: false, error: null, token: 0,
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
      folder: [], folderIndex: -1, meta: null, view: null, orient: null, guides: { v: [], h: [] }, layer: 0, layers: null, loading: false, error: null, token: 0,
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
      status: "loading", error: null, tree: [], count: 0, useLayers: false, selectedId: null, stats: null, diff: null,
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
  edit(tab: Tab, key: string | null, mutate: (tree: DocLayer[]) => void) {
    const l = tab.layers;
    if (!l || l.status !== "ready") return;
    const h = this.hist(tab);
    const now = performance.now();
    if (!(key && h.lastKey === key && now - h.lastTime < 1000)) {
      h.undo.push(cloneTree(l.tree));
      if (h.undo.length > HISTORY_MAX) h.undo.shift();
      h.redo = [];
    }
    h.lastKey = key;
    h.lastTime = now;
    mutate(l.tree);
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
      id: doc.nextId++, origId: null, dup: false, name, kind: group ? "group" : "pixel", hidden: false, opacity: 1, fill: 1,
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
    tab.layers!.selectedId = node.id;
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

  /** Ctrl+J: copy of the selected layer (or group) above it */
  duplicate(tab: Tab) {
    const doc = this.docs.get(tab.id);
    const l = tab.layers;
    const at = l && this.locate(l.tree, l.selectedId);
    if (!doc || !l || !at) return;
    const copy = (src: DocLayer): DocLayer => {
      const c = { ...cloneTree([src])[0], id: doc.nextId++, dup: src.origId !== null, children: null as DocLayer[] | null };
      const g = doc.gpu.get(src.id);
      if (g) doc.gpu.set(c.id, g); // share the textures (pixels are not edited yet)
      c.children = src.children ? src.children.map(copy) : null;
      return c;
    };
    const c = copy(at.node);
    c.name = `${at.node.name} のコピー`;
    this.insert(tab, c, "複製");
  }

  deleteSelected(tab: Tab) {
    const l = tab.layers;
    const at = l && this.locate(l.tree, l.selectedId);
    if (!l || !at) return;
    const next = at.list[at.index - 1] ?? at.list[at.index + 1] ?? at.parent;
    this.edit(tab, null, () => { at.list.splice(at.index, 1); });
    l.selectedId = next?.id ?? null;
  }

  /** Ctrl+G: puts the selected layer into a new group */
  groupSelected(tab: Tab) {
    const doc = this.docs.get(tab.id);
    const l = tab.layers;
    if (!doc || !l || l.selectedId === null) return;
    const g = this.newLayerData(doc, `グループ ${this.countLayers(l.tree) + 1}`, true);
    this.edit(tab, null, (tree) => {
      const at = this.locate(tree, l.selectedId)!;
      const [node] = at.list.splice(at.index, 1, g);
      node.clipping = false;
      g.children = [node];
    });
    l.selectedId = g.id;
  }

  /** Moves layer `id` above / below / into (top of) layer `target`. */
  move(tab: Tab, id: number, target: number, where: "above" | "below" | "inside") {
    const l = tab.layers;
    if (!l || id === target) return;
    const src = this.locate(l.tree, id);
    if (!src) return;
    // not into itself or its own descendants
    if (src.node.children && this.locate(src.node.children, target)) return;
    this.edit(tab, null, (tree) => {
      const s = this.locate(tree, id)!;
      const [node] = s.list.splice(s.index, 1);
      const t = this.locate(tree, target)!;
      if (where === "inside" && t.node.children) t.node.children.push(node);
      else t.list.splice(where === "above" ? t.index + 1 : t.index, 0, node);
    });
  }

  /** Changes properties of layer `id` (same `key` within 1 s = one undo step, e.g. while dragging a slider). */
  updateLayer(tab: Tab, id: number, patch: Partial<Pick<DocLayer, "name" | "hidden" | "opacity" | "fill" | "blendMode" | "clipping" | "open">> & { maskDisabled?: boolean }, key: string | null = null) {
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
    const rgba = this.renderer.readSet(set);
    const req = {
      src, dst, backup, width: doc.data.width, height: doc.data.height, layerCount: l.fileCount, plan: toPlan(l.tree),
    };
    return { req, rgba: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) };
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
      const renumber = (ls: DocLayer[]) => { for (const x of ls) { if (x.children) renumber(x.children); x.origId = ++n; x.dup = false; } };
      renumber(l.tree);
      l.fileCount = n;
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
