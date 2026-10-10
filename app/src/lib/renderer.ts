// WebGL2 image renderer: tiled textures (images larger than MAX_TEXTURE_SIZE are split),
// mipmapped minification, nearest-neighbour when zoomed in >= 200%, checkerboard behind transparency.
// Several images can live on the GPU at once (TextureSet); one of them is shown.
//
// View transform (image px -> css px): mirror x about the image centre when flipX, rotate by `rotation`
// degrees (clockwise on screen), scale by `scale`, then translate by (offsetX, offsetY).
//
// Compare mode (phase 1-d): a second image B is shown next to / over the active image A. The canvas is
// split into panes (scissor rectangles). B is drawn in A's image space ("A-space"): when `fitB` is on,
// B is scaled uniformly to fit A's size and centred, otherwise its pixels map 1:1 onto A's (top-left aligned). So guides, the
// grid and a linked view apply to both images alike.

const VS = `#version 300 es
in vec2 a_unit;                 // 0..1 quad
uniform vec4 u_rect;            // tile rect in image px (x, y, w, h)
uniform vec3 u_mx;              // view transform rows: css = (dot(u_mx, (img, 1)), dot(u_my, (img, 1)))
uniform vec3 u_my;
uniform vec2 u_canvas;          // canvas size in css px
out vec2 v_uv;
void main() {
  vec3 img = vec3(u_rect.xy + a_unit * u_rect.zw, 1.0);
  vec2 css = vec2(dot(u_mx, img), dot(u_my, img));
  vec2 clip = css / u_canvas * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_unit;
}`;

// Pixels are premultiplied. 8-bit textures hold display-ready (sRGB) values; half-float (HDR) textures hold
// linear light: they are scaled by the exposure, composited in linear and then encoded to sRGB.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_dpr;
uniform bool u_hdr;
uniform float u_exposure;   // linear multiplier (2^EV), HDR only
uniform int u_channel;      // 0 = RGB, 1..3 = R/G/B, 4 = alpha (shown as grey, unpremultiplied)
out vec4 o;
vec3 toSrgb(vec3 x) {
  x = max(x, 0.0);
  return mix(x * 12.92, 1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, x));
}
void main() {
  vec4 c = texture(u_tex, v_uv);
  if (u_channel > 0) {
    float v = u_channel == 4 ? c.a : (c.a > 0.0 ? c[u_channel - 1] / c.a : 0.0);
    vec3 g = vec3(v);
    o = vec4(u_hdr && u_channel != 4 ? toSrgb(g * u_exposure) : clamp(g, 0.0, 1.0), 1.0);
    return;
  }
  vec2 cell = floor(gl_FragCoord.xy / (8.0 * u_dpr));
  float k = mod(cell.x + cell.y, 2.0) < 1.0 ? 0.42 : 0.32;
  if (u_hdr) o = vec4(toSrgb(c.rgb * u_exposure + vec3(pow(k, 2.2)) * (1.0 - c.a)), 1.0);
  else o = vec4(c.rgb + vec3(k) * (1.0 - c.a), 1.0);
}`;

type Tile = { tex: WebGLTexture; x: number; y: number; w: number; h: number };

/** One image uploaded to the GPU (one or more tiles). `thumb` is made on demand for the navigator. */
export type TextureSet = {
  readonly id: number; tiles: Tile[]; width: number; height: number; bytes: number; thumb?: HTMLCanvasElement;
  /** half-float linear data (EXR / HDR) */
  hdr: boolean;
  /** has a mipmap chain (half-float textures need EXT_color_buffer_float for it) */
  mips: boolean;
};

/** How pixels are shown: exposure in EV (HDR images only) and the channel view. */
export type ChannelView = 0 | 1 | 2 | 3 | 4;
export type DisplayState = { exposure: number; channel: ChannelView };

/** rotation in degrees (clockwise on screen), flipX = mirrored left-right (view only, the image is not changed) */
export type ViewState = { scale: number; offsetX: number; offsetY: number; rotation: number; flipX: boolean };
export type Orientation = { rotation: number; flipX: boolean };

/** 2x3 affine transform rows: x' = a*x + b*y + c, y' = d*x + e*y + f */
export type Affine = [number, number, number, number, number, number];

let setSeq = 0;

export type ImageSource =
  | { kind: "rgba"; width: number; height: number; data: Uint8ClampedArray; premultiplied?: boolean }
  | { kind: "bitmap"; width: number; height: number; bitmap: ImageBitmap }
  /** RGBA half floats (raw u16 bits), premultiplied, linear */
  | { kind: "half"; width: number; height: number; data: Uint16Array };

/** One view transform (zoom / pan / rotation / flip) for a viewport of vw x vh css px. */
export class View {
  scale = 1;
  offsetX = 0;
  offsetY = 0;
  rotation = 0;
  flipX = false;
  /** size of the image space (flip mirrors about its centre, fit uses it) */
  imgW = 0;
  imgH = 0;
  /** viewport size in css px */
  vw = 1;
  vh = 1;

  get state(): ViewState {
    return { scale: this.scale, offsetX: this.offsetX, offsetY: this.offsetY, rotation: this.rotation, flipX: this.flipX };
  }
  set state(v: ViewState) {
    this.scale = v.scale; this.offsetX = v.offsetX; this.offsetY = v.offsetY;
    this.rotation = v.rotation ?? 0; this.flipX = v.flipX ?? false;
  }

  /** image px -> css px (relative to the viewport origin) */
  get matrix(): Affine {
    const r = (this.rotation * Math.PI) / 180;
    const c = Math.cos(r) * this.scale, s = Math.sin(r) * this.scale;
    const fx = this.flipX ? -1 : 1, tx = this.flipX ? this.imgW : 0;
    return [c * fx, -s, this.offsetX + c * tx, s * fx, c, this.offsetY + s * tx];
  }

  imageToView(x: number, y: number): [number, number] { return apply(this.matrix, x, y); }
  viewToImage(cx: number, cy: number): [number, number] { return applyInverse(this.matrix, cx, cy); }

  /** Puts image point (ix, iy) at viewport point (cx, cy) with the current scale / rotation / flip. */
  pin(ix: number, iy: number, cx: number, cy: number) {
    this.offsetX = 0; this.offsetY = 0;
    const [px, py] = this.imageToView(ix, iy);
    this.offsetX = cx - px; this.offsetY = cy - py;
  }

  /** Whole image in view (keeps rotation / flip; the rotated bounding box is fitted). */
  fit() {
    if (!this.imgW || !this.imgH) return;
    const r = (this.rotation * Math.PI) / 180;
    const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
    const w = this.imgW, h = this.imgH;
    this.scale = Math.min(this.vw / (w * c + h * s), this.vh / (w * s + h * c), 1) * 0.98;
    this.pin(w / 2, h / 2, this.vw / 2, this.vh / 2);
  }

  /** Zoom keeping the image point under viewport point (cx, cy) fixed. */
  zoomAt(newScale: number, cx: number, cy: number) {
    newScale = Math.min(64, Math.max(0.01, newScale));
    const [ix, iy] = this.viewToImage(cx, cy);
    this.scale = newScale;
    this.pin(ix, iy, cx, cy);
  }

  /** Rotates around the centre of the viewport. */
  rotateTo(deg: number) {
    deg = ((deg % 360) + 540) % 360 - 180; // -180 < deg <= 180
    if (Math.abs(deg) < 1e-9) deg = 0;
    const [ix, iy] = this.viewToImage(this.vw / 2, this.vh / 2);
    this.rotation = deg;
    this.pin(ix, iy, this.vw / 2, this.vh / 2);
  }

  /** Mirrors left-right around the centre of the viewport. */
  setFlip(flip: boolean) {
    const [ix, iy] = this.viewToImage(this.vw / 2, this.vh / 2);
    this.flipX = flip;
    this.pin(ix, iy, this.vw / 2, this.vh / 2);
  }

  centerOn(ix: number, iy: number) { this.pin(ix, iy, this.vw / 2, this.vh / 2); }

  panBy(dx: number, dy: number) { this.offsetX += dx; this.offsetY += dy; }

  /** New viewport size: keeps the image point in the centre where it was. */
  resizeTo(vw: number, vh: number) {
    if (vw === this.vw && vh === this.vh) return;
    const [ix, iy] = this.viewToImage(this.vw / 2, this.vh / 2);
    this.vw = vw; this.vh = vh;
    if (this.imgW) this.pin(ix, iy, vw / 2, vh / 2);
  }

  copyFrom(o: View) { this.state = o.state; this.imgW = o.imgW; this.imgH = o.imgH; this.vw = o.vw; this.vh = o.vh; }
}

export function apply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

export function applyInverse(m: Affine, cx: number, cy: number): [number, number] {
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d;
  const x = cx - c, y = cy - f;
  return [(e * x - b * y) / det, (a * y - d * x) / det];
}

/** m then translate by (tx, ty) */
const translate = (m: Affine, tx: number, ty: number): Affine => [m[0], m[1], m[2] + tx, m[3], m[4], m[5] + ty];
/** x -> k*x + (tx, ty), then m */
const premap = (m: Affine, k: number, tx: number, ty: number): Affine =>
  [m[0] * k, m[1] * k, m[0] * tx + m[1] * ty + m[2], m[3] * k, m[4] * k, m[3] * tx + m[4] * ty + m[5]];

export type CompareMode = "side" | "swipe" | "toggle";
export type CompareState = {
  /** image B */
  set: TextureSet;
  mode: CompareMode;
  /** side by side: both panes share A's view (otherwise B has its own view) */
  linked: boolean;
  /** B scaled uniformly to fit A's size, centred (otherwise pixel 1:1, top-left aligned) */
  fitB: boolean;
  /** swipe: divider position, 0..1 of the canvas width */
  split: number;
  /** toggle: B is shown instead of A */
  showB: boolean;
};

/** A drawable area of the canvas. `matrix` maps A-space to canvas css px, `texMatrix` maps the set's own pixels. */
export type Pane = {
  which: "A" | "B";
  /** clip rectangle in canvas css px */
  x: number; y: number; w: number; h: number;
  /** origin of the view's viewport in canvas css px */
  ox: number; oy: number;
  view: View;
  set: TextureSet;
  matrix: Affine;
  texMatrix: Affine;
  /** css px per texture px (for the sampler choice) */
  texScale: number;
};

const SIDE_GAP = 2; // css px between the panes

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly maxTextureSize: number;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private smoothSampler: WebGLSampler;
  private nearestSampler: WebGLSampler;
  private smoothNoMip: WebGLSampler;
  private nearestNoMip: WebGLSampler;
  /** half-float textures can be rendered to (mipmaps, pixel read-back) */
  readonly floatRenderable: boolean;
  /** exposure (EV) for HDR images and the channel view; shared by all panes */
  readonly display: DisplayState = { exposure: 0, channel: 0 };
  private active: TextureSet | null = null;
  private live = new Set<TextureSet>();
  /** view of image A (the active tab) */
  readonly view = new View();
  /** view of the right pane when comparing side by side without linking */
  readonly viewB = new View();
  private cmp: CompareState | null = null;
  private rafPending = false;
  private frameListeners = new Set<() => void>();

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: true, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 が使えません");
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
    this.prog = p;
    for (const n of ["u_rect", "u_mx", "u_my", "u_canvas", "u_tex", "u_dpr", "u_hdr", "u_exposure", "u_channel"]) this.loc[n] = gl.getUniformLocation(p, n);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const aLoc = gl.getAttribLocation(p, "a_unit");
    gl.enableVertexAttribArray(aLoc);
    gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);

    const mkSampler = (min: number, mag: number) => {
      const s = gl.createSampler()!;
      gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, min);
      gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, mag);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return s;
    };
    this.smoothSampler = mkSampler(gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR);
    this.nearestSampler = mkSampler(gl.LINEAR_MIPMAP_LINEAR, gl.NEAREST);
    this.smoothNoMip = mkSampler(gl.LINEAR, gl.LINEAR);
    this.nearestNoMip = mkSampler(gl.LINEAR, gl.NEAREST);
    this.floatRenderable = !!gl.getExtension("EXT_color_buffer_float");
  }

  get hasImage() { return this.active !== null; }
  get imageWidth() { return this.active?.width ?? 0; }
  get imageHeight() { return this.active?.height ?? 0; }
  /** GPU memory of all images currently uploaded (approximate, incl. mipmaps) */
  get textureBytes() { let b = 0; for (const s of this.live) b += s.bytes; return b; }
  get textureCount() { return this.live.size; }
  get activeSet() { return this.active; }
  get compare() { return this.cmp; }

  /** Shows `set` as image A (or nothing). Does not free anything. */
  show(set: TextureSet | null) {
    this.active = set;
    this.view.imgW = this.viewB.imgW = set?.width ?? 0;
    this.view.imgH = this.viewB.imgH = set?.height ?? 0;
    this.requestDraw();
  }

  /** Stops showing the current image (textures stay alive). */
  clear() { this.show(null); }

  /** Frees the GPU textures of `set`. */
  dispose(set: TextureSet) {
    if (!this.live.delete(set)) return;
    for (const t of set.tiles) this.gl.deleteTexture(t.tex);
    set.tiles = [];
    if (this.active === set) this.show(null);
    if (this.cmp?.set === set) this.setCompare(null);
  }

  /** Starts / updates / ends (null) the comparison with image B. Pane sizes change, so the views are re-laid out. */
  setCompare(c: CompareState | null) {
    const wasSide = this.cmp?.mode === "side", wasLinked = this.cmp?.linked ?? true;
    this.cmp = c;
    const side = c?.mode === "side";
    if (side && (!wasSide || (wasLinked && !c!.linked))) {
      // the right pane starts as a copy of the left one
      this.layout();
      this.viewB.copyFrom(this.view);
    }
    this.layout();
    this.requestDraw();
  }

  // ---------------------------------------------------------------- view of image A (pane 0, origin = canvas origin)

  get scale() { return this.view.scale; }
  get offsetX() { return this.view.offsetX; }
  get offsetY() { return this.view.offsetY; }
  get rotation() { return this.view.rotation; }
  get flipX() { return this.view.flipX; }
  /** A-space -> css px of pane 0 (= canvas css px, pane 0 starts at the canvas origin) */
  get matrix(): Affine { return this.view.matrix; }
  imageToView(x: number, y: number) { return this.view.imageToView(x, y); }
  viewToImage(cx: number, cy: number) { return this.view.viewToImage(cx, cy); }
  /** size of pane 0 (the whole canvas unless comparing side by side) */
  get viewWidth() { return this.view.vw; }
  get viewHeight() { return this.view.vh; }

  getView(): ViewState { return this.view.state; }
  setView(v: ViewState) { this.view.state = v; this.requestDraw(); }
  setOrientation(o: Orientation) { this.view.rotation = o.rotation; this.view.flipX = o.flipX; this.requestDraw(); }

  /** Fits A (and B's own view when it is not linked). */
  fit() {
    if (!this.hasImage) return;
    this.view.fit();
    if (this.unlinkedB) this.viewB.fit();
    this.requestDraw();
  }
  zoomAt(s: number, cx: number, cy: number) { this.view.zoomAt(s, cx, cy); this.requestDraw(); }
  rotateTo(deg: number) { this.view.rotateTo(deg); this.requestDraw(); }
  setFlip(flip: boolean) { this.view.setFlip(flip); this.requestDraw(); }
  centerOn(ix: number, iy: number) { this.view.centerOn(ix, iy); this.requestDraw(); }
  panBy(dx: number, dy: number) { this.view.panBy(dx, dy); this.requestDraw(); }

  /** Called after every frame (also when nothing is shown) — overlays redraw in sync with the image. */
  onFrame(fn: () => void) { this.frameListeners.add(fn); return () => { this.frameListeners.delete(fn); }; }

  // ---------------------------------------------------------------- panes

  private get unlinkedB() { return this.cmp?.mode === "side" && !this.cmp.linked; }

  private get cssSize() {
    const r = this.canvas.getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  }

  /** Pane rectangles for the current mode; also sizes the views. */
  private layout() {
    const { w, h } = this.cssSize;
    if (this.cmp?.mode === "side") {
      const w0 = Math.floor((w - SIDE_GAP) / 2);
      this.view.resizeTo(w0, h);
      this.viewB.resizeTo(w - w0 - SIDE_GAP, h);
    } else {
      this.view.resizeTo(w, h);
    }
  }

  /** The panes to draw (in order). Empty when nothing is shown. */
  panes(): Pane[] {
    const a = this.active;
    if (!a) return [];
    const { w, h } = this.cssSize;
    const paneA = (x: number, cw: number): Pane => ({
      which: "A", x, y: 0, w: cw, h, ox: 0, oy: 0, view: this.view, set: a,
      matrix: this.view.matrix, texMatrix: this.view.matrix, texScale: this.view.scale,
    });
    const c = this.cmp;
    if (!c) return [paneA(0, w)];
    const b = c.set;
    // B pixel -> A-space: x * k + (tx, ty)
    const k = c.fitB ? Math.min(a.width / b.width, a.height / b.height) : 1;
    const tx = c.fitB ? (a.width - b.width * k) / 2 : 0, ty = c.fitB ? (a.height - b.height * k) / 2 : 0;
    const paneB = (view: View, x: number, cw: number, ox: number): Pane => {
      const m = translate(view.matrix, ox, 0);
      return { which: "B", x, y: 0, w: cw, h, ox, oy: 0, view, set: b, matrix: m, texMatrix: premap(m, k, tx, ty), texScale: view.scale * k };
    };
    if (c.mode === "side") {
      const x1 = this.view.vw + SIDE_GAP;
      return [paneA(0, this.view.vw), paneB(c.linked ? this.view : this.viewB, x1, w - x1, x1)];
    }
    if (c.mode === "swipe") {
      const sx0 = Math.round(Math.min(1, Math.max(0, c.split)) * w);
      return [paneA(0, sx0), paneB(this.view, sx0, w - sx0, 0)];
    }
    return [c.showB ? paneB(this.view, 0, w, 0) : paneA(0, w)];
  }

  /** The pane under canvas point (cx, cy) — the one whose view an interaction there should change. */
  paneAt(cx: number, cy: number): Pane | null {
    const ps = this.panes();
    if (this.cmp?.mode === "side") return ps.find((p) => cx >= p.x - SIDE_GAP && cx < p.x + p.w) ?? ps[ps.length - 1] ?? null;
    // swipe / toggle / single: one shared view; report the pane that is visible there
    return ps.find((p) => cx >= p.x && cx < p.x + p.w && cy >= p.y && cy < p.y + p.h) ?? ps[0] ?? null;
  }

  /** Uploads the image as one or more tiles (not shown yet). Returns the set and the upload time in ms (GPU-synchronised). */
  async upload(src: ImageSource): Promise<{ set: TextureSet; ms: number }> {
    const gl = this.gl;
    const t0 = performance.now();
    const T = Math.min(this.maxTextureSize, 8192);
    const hdr = src.kind === "half";
    const mips = !hdr || this.floatRenderable;
    const set: TextureSet = { id: ++setSeq, tiles: [], width: src.width, height: src.height, bytes: 0, hdr, mips };
    this.live.add(set);

    for (let y = 0; y < src.height; y += T) {
      for (let x = 0; x < src.width; x += T) {
        const w = Math.min(T, src.width - x);
        const h = Math.min(T, src.height - y);
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const levels = mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
        gl.texStorage2D(gl.TEXTURE_2D, levels, hdr ? gl.RGBA16F : gl.RGBA8, w, h);
        if (src.kind === "half") {
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, src.width);
          gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
          gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.HALF_FLOAT, src.data);
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
          gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
          gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        } else if (src.kind === "rgba") {
          // already-premultiplied data takes the fast upload path (no per-pixel conversion in the browser)
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !src.premultiplied);
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, src.width);
          gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
          gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, src.data);
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
          gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
          gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        } else {
          // ImageBitmap was created premultiplied; crop when the image needs several tiles
          const part = (x === 0 && y === 0 && w === src.width && h === src.height)
            ? src.bitmap
            : await createImageBitmap(src.bitmap, x, y, w, h, { premultiplyAlpha: "premultiply" });
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, part);
          if (part !== src.bitmap) part.close();
        }
        if (mips) gl.generateMipmap(gl.TEXTURE_2D);
        set.tiles.push({ tex, x, y, w, h });
        set.bytes += Math.round(w * h * (hdr ? 8 : 4) * (mips ? 4 / 3 : 1));
      }
    }
    if (src.kind === "bitmap") src.bitmap.close();
    // force GPU sync so the measured time includes the upload
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { set, ms: performance.now() - t0 };
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.layout();
    this.requestDraw();
  }

  requestDraw() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => { this.rafPending = false; this.draw(); });
  }

  /** Last frame's CPU-side draw time (ms), for diagnostics. */
  lastDrawMs = 0;

  draw() {
    const t0 = performance.now();
    const gl = this.gl;
    this.layout();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.118, 0.118, 0.118, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const dpr = this.canvas.width / this.cssSize.w;
    const { w, h } = this.cssSize;
    gl.enable(gl.SCISSOR_TEST);
    for (const p of this.panes()) {
      // scissor in device px, origin bottom-left
      const x0 = Math.round(p.x * dpr), x1 = Math.round((p.x + p.w) * dpr);
      const y0 = Math.round((h - p.y - p.h) * dpr), y1 = Math.round((h - p.y) * dpr);
      if (x1 <= x0 || y1 <= y0) continue;
      gl.scissor(x0, y0, x1 - x0, y1 - y0);
      this.drawSet(p.set, p.texMatrix, w, h, window.devicePixelRatio || 1, p.texScale >= 2);
    }
    gl.disable(gl.SCISSOR_TEST);
    this.lastDrawMs = performance.now() - t0;
    for (const fn of this.frameListeners) fn();
  }

  private drawSet(set: TextureSet, m: Affine, cssW: number, cssH: number, dpr: number, nearest: boolean, display: DisplayState = this.display) {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniform3f(this.loc.u_mx, m[0], m[1], m[2]);
    gl.uniform3f(this.loc.u_my, m[3], m[4], m[5]);
    gl.uniform2f(this.loc.u_canvas, cssW, cssH);
    gl.uniform1f(this.loc.u_dpr, dpr);
    gl.uniform1i(this.loc.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindSampler(0, set.mips ? (nearest ? this.nearestSampler : this.smoothSampler) : (nearest ? this.nearestNoMip : this.smoothNoMip));
    gl.uniform1i(this.loc.u_hdr, set.hdr ? 1 : 0);
    gl.uniform1f(this.loc.u_exposure, 2 ** display.exposure);
    gl.uniform1i(this.loc.u_channel, display.channel);
    for (const t of set.tiles) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform4f(this.loc.u_rect, t.x, t.y, t.w, t.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  /** Registers textures created elsewhere (the layer compositor) as a TextureSet owned by this renderer. */
  adopt(s: Omit<TextureSet, "id">): TextureSet {
    const set: TextureSet = { id: ++setSeq, ...s };
    this.live.add(set);
    return set;
  }

  /** Reads a whole 8-bit image back from the GPU: RGBA, premultiplied, rows top to bottom. */
  readSet(set: TextureSet): Uint8Array {
    if (set.hdr) throw new Error("readSet: HDR images are not supported");
    const gl = this.gl;
    const out = new Uint8Array(set.width * set.height * 4);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, set.width);
    for (const t of set.tiles) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, out.subarray((t.y * set.width + t.x) * 4));
    }
    gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return out;
  }

  /** Exposure (EV, HDR images) and channel view. */
  setDisplay(d: Partial<DisplayState>) {
    Object.assign(this.display, d);
    this.requestDraw();
  }

  /** Stored value of pixel (x, y) of `set`: 0..255 (unpremultiplied) for 8-bit images, raw floats for HDR.
   *  Null outside the image, or when the GPU cannot read half floats back. */
  readPixel(set: TextureSet, x: number, y: number): { values: [number, number, number, number]; float: boolean } | null {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= set.width || y >= set.height) return null;
    const t = set.tiles.find((t) => x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h);
    if (!t || (set.hdr && !this.floatRenderable)) return null;
    const gl = this.gl;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    let values: [number, number, number, number] | null = null;
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      if (set.hdr) {
        const px = new Float32Array(4);
        gl.readPixels(x - t.x, y - t.y, 1, 1, gl.RGBA, gl.FLOAT, px);
        values = [px[0], px[1], px[2], px[3]];
      } else {
        const px = new Uint8Array(4);
        gl.readPixels(x - t.x, y - t.y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const a = px[3];
        const un = (v: number) => (a > 0 ? Math.min(255, Math.round((v * 255) / a)) : 0);
        values = [un(px[0]), un(px[1]), un(px[2]), a];
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return values ? { values, float: set.hdr } : null;
  }

  /** Average colour of the square of `size` px centred on (x, y) (8-bit images): straight RGBA 0..255, or null. */
  readAverage(set: TextureSet, x: number, y: number, size: number): [number, number, number, number] | null {
    if (set.hdr) return null;
    const r = Math.floor(size / 2);
    const x0 = Math.max(0, Math.floor(x) - r), y0 = Math.max(0, Math.floor(y) - r);
    const x1 = Math.min(set.width, Math.floor(x) + r + 1), y1 = Math.min(set.height, Math.floor(y) + r + 1);
    if (x1 <= x0 || y1 <= y0) return null;
    const gl = this.gl;
    const sum = [0, 0, 0, 0];
    let n = 0;
    for (const t of set.tiles) {
      const ax = Math.max(x0, t.x), ay = Math.max(y0, t.y), bx = Math.min(x1, t.x + t.w), by = Math.min(y1, t.y + t.h);
      if (bx <= ax || by <= ay) continue;
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      const px = new Uint8Array((bx - ax) * (by - ay) * 4);
      gl.readPixels(ax - t.x, ay - t.y, bx - ax, by - ay, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      for (let i = 0; i < px.length; i += 4) { sum[0] += px[i]; sum[1] += px[i + 1]; sum[2] += px[i + 2]; sum[3] += px[i + 3]; n++; }
    }
    if (!n) return null;
    const a = sum[3] / n;
    // premultiplied average -> straight
    return a > 0 ? [sum[0] / n * 255 / a, sum[1] / n * 255 / a, sum[2] / n * 255 / a, a] : [0, 0, 0, 0];
  }

  /** Small image of `set` (longest side `size` px, transparency on a checkerboard) for the navigator. Cached on the set. */
  thumbnail(set: TextureSet, size = 256): HTMLCanvasElement | null {
    if (set.thumb) return set.thumb;
    if (!set.tiles.length) return null;
    const gl = this.gl;
    const k = Math.min(1, size / Math.max(set.width, set.height));
    const w = Math.max(1, Math.round(set.width * k)), h = Math.max(1, Math.round(set.height * k));
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.118, 0.118, 0.118, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawSet(set, [w / set.width, 0, 0, 0, h / set.height, 0], w, h, 0.5, false, { exposure: 0, channel: 0 });
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    // readPixels starts at the bottom row (the image's bottom edge): flip rows
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.putImageData(new ImageData(out, w, h), 0, 0);
    set.thumb = canvas;
    this.requestDraw();
    return canvas;
  }
}
