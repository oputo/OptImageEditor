// Viewer state: tabs, per-tab folder navigation, GPU texture cache and prefetch of neighbour images.
//
// GPU cache policy (phase 1-b): keep textures only for
//   1. the active tab, 2. the next / previous image in the active tab's folder (prefetched),
//   3. the two most recently used other tabs.
// Everything else is freed; a tab whose texture was freed is decoded again when activated (~0.2 s).
import { loadImage, SUPPORTED_EXT, type LoadedImage } from "./loader";
import type { Renderer, TextureSet, ViewState } from "./renderer";
import { BrowserFileSource, TauriFileSource, baseName, type FileSource } from "./source";
import { listFolderImages, setWindowTitle } from "./desktop";
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
  loading: boolean;
  error: string | null;
  token: number;
};

const GPU_BUDGET = 2 * 1024 ** 3; // bytes, incl. mipmaps
const KEEP_OTHER_TABS = 2;
const PREFETCH_DELAY_MS = 150;

const isSupported = (p: string) => SUPPORTED_EXT.includes(p.split(".").pop()?.toLowerCase() ?? "");
const keyOf = (path: string) => path.toLowerCase();

export class ViewerState {
  tabs = $state<Tab[]>([]);
  activeId = $state<number | null>(null);
  zoom = $state(0);
  /** bumps whenever the GPU cache changes (for the stats panel) */
  cacheVersion = $state(0);

  renderer: Renderer | undefined;
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<CacheEntry>>();
  private mru: number[] = [];
  private closed: { path: string }[] = [];
  private prefetchToken = 0;
  private seq = 0;

  get active(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
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
        folder: [], folderIndex: -1, meta: null, view: null, loading: false, error: null, token: 0,
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
      folder: [], folderIndex: -1, meta: null, view: null, loading: false, error: null, token: 0,
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
    this.activeId = id;
    this.mru = [id, ...this.mru.filter((x) => x !== id)];
    const entry = this.cache.get(tab.key);
    if (entry) {
      this.present(tab, entry, true);
    } else {
      this.renderer?.show(null);
      if (!tab.loading) this.loadTab(tab);
    }
    this.updateTitle();
    this.enforceCache();
    this.schedulePrefetch();
  }

  cycle(delta: number) {
    if (this.tabs.length < 2 || this.activeId === null) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length].id);
  }

  close(id: number) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    tab.token++; // cancel a pending load
    if (tab.path) this.closed.push({ path: tab.path });
    if (this.closed.length > 20) this.closed.shift();
    this.mru = this.mru.filter((x) => x !== id);
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

  goTo(index: number) {
    const tab = this.active;
    if (!tab?.path || tab.folder.length === 0) return;
    const i = Math.max(0, Math.min(tab.folder.length - 1, index));
    const path = tab.folder[i];
    tab.path = path;
    tab.key = keyOf(path);
    tab.name = baseName(path);
    tab.folderIndex = i;
    tab.view = null;
    const entry = this.cache.get(tab.key);
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

  /** Reloads the active image from disk (drops its cached texture). */
  reload() {
    const tab = this.active;
    if (!tab) return;
    const e = this.cache.get(tab.key);
    if (e) { this.cache.delete(tab.key); this.renderer?.dispose(e.set); this.cacheVersion++; }
    tab.view = null;
    this.loadTab(tab);
  }

  // ---------------------------------------------------------------- loading

  private async loadTab(tab: Tab) {
    const token = ++tab.token;
    const key = tab.key;
    tab.loading = true;
    tab.error = null;
    try {
      const src: FileSource = tab.file ? new BrowserFileSource(tab.file) : await TauriFileSource.open(tab.path!);
      const entry = await this.decodeAndUpload(src, key);
      if (token !== tab.token) return; // superseded (navigated away / closed)
      this.present(tab, entry, false);
      if (tab.path) recent.add(tab.path);
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
  private decodeAndUpload(src: FileSource, key: string): Promise<CacheEntry> {
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = (async () => {
      const t0 = performance.now();
      const img = await loadImage(src);
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
    else this.renderer.fit();
    this.zoom = this.renderer.scale;
    this.updateTitle();
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
    if (active) keep.push(active.key);
    for (const p of this.neighbourPaths(active)) keep.push(keyOf(p));
    for (const id of this.mru.slice(0, KEEP_OTHER_TABS + 1)) {
      const t = this.tab(id);
      if (t && t.id !== active?.id) keep.push(t.key);
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
      if (this.renderer?.activeSet === e.set) continue; // never free what is on screen
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

  // ---------------------------------------------------------------- misc

  updateTitle() {
    const t = this.active;
    if (!t) { setWindowTitle("OptImageEditor"); return; }
    const pos = t.folder.length && t.folderIndex >= 0 ? ` (${t.folderIndex + 1}/${t.folder.length})` : "";
    setWindowTitle(`${t.name}${pos} — OptImageEditor`);
  }
}
