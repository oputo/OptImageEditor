// Display options (navigator, rulers, guides, grid, pixel grid), persisted in localStorage.
const KEY = "oie.view";

export type GridMode = "off" | "thirds" | "center" | "px";
export const GRID_LABEL: Record<GridMode, string> = { off: "なし", thirds: "三分割", center: "中心線", px: "格子" };

type Saved = {
  navigator: boolean;
  rulers: boolean;
  extras: boolean;
  guides: boolean;
  grid: GridMode;
  gridPx: number;
  pixelGrid: boolean;
};

const DEFAULTS: Saved = { navigator: true, rulers: false, extras: true, guides: true, grid: "off", gridPx: 128, pixelGrid: true };

function load(): Saved {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

class ViewOptions {
  private s = load();
  /** navigator panel (N) */
  navigator = $state(this.s.navigator);
  /** rulers (Ctrl+R); hidden while the view is rotated */
  rulers = $state(this.s.rulers);
  /** master switch for guides / grid / pixel grid (Ctrl+H, like Photoshop's "Extras") */
  extras = $state(this.s.extras);
  guides = $state(this.s.guides);
  grid = $state<GridMode>(this.s.grid);
  /** spacing of the "格子" grid in image px */
  gridPx = $state(this.s.gridPx);
  /** pixel borders when zoomed in to 800% or more */
  pixelGrid = $state(this.s.pixelGrid);
  /** last grid mode other than "off" (G toggles between it and off) */
  private lastGrid: GridMode = this.s.grid === "off" ? "thirds" : this.s.grid;

  constructor() {
    $effect.root(() => {
      $effect(() => {
        const v: Saved = {
          navigator: this.navigator, rulers: this.rulers, extras: this.extras, guides: this.guides,
          grid: this.grid, gridPx: this.gridPx, pixelGrid: this.pixelGrid,
        };
        if (v.grid !== "off") this.lastGrid = v.grid;
        try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage unavailable */ }
      });
    });
  }

  toggleGrid() {
    this.grid = this.grid === "off" ? this.lastGrid : "off";
    this.extras = true;
  }
}

export const viewOptions = new ViewOptions();
