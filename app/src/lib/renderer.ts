// WebGL2 image renderer: tiled textures (images larger than MAX_TEXTURE_SIZE are split),
// mipmapped minification, nearest-neighbour when zoomed in >= 200%, checkerboard behind transparency.
// Several images can live on the GPU at once (TextureSet); one of them is shown.
//
// View transform (image px -> css px): mirror x about the image centre when flipX, rotate by `rotation`
// degrees (clockwise on screen), scale by `scale`, then translate by (offsetX, offsetY).

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

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_dpr;
out vec4 o;
void main() {
  vec4 c = texture(u_tex, v_uv);                       // premultiplied alpha
  vec2 cell = floor(gl_FragCoord.xy / (8.0 * u_dpr));
  float k = mod(cell.x + cell.y, 2.0) < 1.0 ? 0.42 : 0.32;
  o = vec4(c.rgb + vec3(k) * (1.0 - c.a), 1.0);
}`;

type Tile = { tex: WebGLTexture; x: number; y: number; w: number; h: number };

/** One image uploaded to the GPU (one or more tiles). `thumb` is made on demand for the navigator. */
export type TextureSet = { readonly id: number; tiles: Tile[]; width: number; height: number; bytes: number; thumb?: HTMLCanvasElement };

/** rotation in degrees (clockwise on screen), flipX = mirrored left-right (view only, the image is not changed) */
export type ViewState = { scale: number; offsetX: number; offsetY: number; rotation: number; flipX: boolean };
export type Orientation = { rotation: number; flipX: boolean };

/** 2x3 affine transform rows: x' = a*x + b*y + c, y' = d*x + e*y + f */
export type Affine = [number, number, number, number, number, number];

let setSeq = 0;

export type ImageSource =
  | { kind: "rgba"; width: number; height: number; data: Uint8ClampedArray; premultiplied?: boolean }
  | { kind: "bitmap"; width: number; height: number; bitmap: ImageBitmap };

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly maxTextureSize: number;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private smoothSampler: WebGLSampler;
  private nearestSampler: WebGLSampler;
  private active: TextureSet | null = null;
  private live = new Set<TextureSet>();
  // view: css px per image px, and image origin position in css px
  scale = 1;
  offsetX = 0;
  offsetY = 0;
  rotation = 0;
  flipX = false;
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
    for (const n of ["u_rect", "u_mx", "u_my", "u_canvas", "u_tex", "u_dpr"]) this.loc[n] = gl.getUniformLocation(p, n);

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
  }

  get hasImage() { return this.active !== null; }
  get imageWidth() { return this.active?.width ?? 0; }
  get imageHeight() { return this.active?.height ?? 0; }
  /** GPU memory of all images currently uploaded (approximate, incl. mipmaps) */
  get textureBytes() { let b = 0; for (const s of this.live) b += s.bytes; return b; }
  get textureCount() { return this.live.size; }
  get activeSet() { return this.active; }

  /** Shows `set` (or nothing). Does not free anything. */
  show(set: TextureSet | null) {
    this.active = set;
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
  }

  getView(): ViewState {
    return { scale: this.scale, offsetX: this.offsetX, offsetY: this.offsetY, rotation: this.rotation, flipX: this.flipX };
  }
  setView(v: ViewState) {
    this.scale = v.scale; this.offsetX = v.offsetX; this.offsetY = v.offsetY;
    this.rotation = v.rotation ?? 0; this.flipX = v.flipX ?? false;
    this.requestDraw();
  }
  setOrientation(o: Orientation) { this.rotation = o.rotation; this.flipX = o.flipX; this.requestDraw(); }

  /** Called after every frame (also when nothing is shown) — overlays redraw in sync with the image. */
  onFrame(fn: () => void) { this.frameListeners.add(fn); return () => { this.frameListeners.delete(fn); }; }

  // ---------------------------------------------------------------- view transform

  /** image px -> css px */
  get matrix(): Affine {
    const r = (this.rotation * Math.PI) / 180;
    const c = Math.cos(r) * this.scale, s = Math.sin(r) * this.scale;
    const fx = this.flipX ? -1 : 1, tx = this.flipX ? this.imageWidth : 0;
    return [c * fx, -s, this.offsetX + c * tx, s * fx, c, this.offsetY + s * tx];
  }

  imageToView(x: number, y: number): [number, number] {
    const m = this.matrix;
    return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
  }

  viewToImage(cx: number, cy: number): [number, number] {
    const [a, b, c, d, e, f] = this.matrix;
    const det = a * e - b * d;
    const x = cx - c, y = cy - f;
    return [(e * x - b * y) / det, (a * y - d * x) / det];
  }

  /** Puts image point (ix, iy) at css point (cx, cy) with the current scale / rotation / flip. */
  private pin(ix: number, iy: number, cx: number, cy: number) {
    this.offsetX = 0; this.offsetY = 0;
    const [px, py] = this.imageToView(ix, iy);
    this.offsetX = cx - px; this.offsetY = cy - py;
  }

  /** Uploads the image as one or more tiles (not shown yet). Returns the set and the upload time in ms (GPU-synchronised). */
  async upload(src: ImageSource): Promise<{ set: TextureSet; ms: number }> {
    const gl = this.gl;
    const t0 = performance.now();
    const T = Math.min(this.maxTextureSize, 8192);
    const set: TextureSet = { id: ++setSeq, tiles: [], width: src.width, height: src.height, bytes: 0 };
    this.live.add(set);

    for (let y = 0; y < src.height; y += T) {
      for (let x = 0; x < src.width; x += T) {
        const w = Math.min(T, src.width - x);
        const h = Math.min(T, src.height - y);
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
        gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, w, h);
        if (src.kind === "rgba") {
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
        gl.generateMipmap(gl.TEXTURE_2D);
        set.tiles.push({ tex, x, y, w, h });
        set.bytes += Math.round(w * h * 4 * 4 / 3);
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
    this.requestDraw();
  }

  get viewWidth() { return this.canvas.getBoundingClientRect().width; }
  get viewHeight() { return this.canvas.getBoundingClientRect().height; }

  /** Whole image in view (keeps rotation / flip; the rotated bounding box is fitted). */
  fit() {
    if (!this.hasImage) return;
    const vw = this.viewWidth, vh = this.viewHeight, w = this.imageWidth, h = this.imageHeight;
    const r = (this.rotation * Math.PI) / 180;
    const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
    this.scale = Math.min(vw / (w * c + h * s), vh / (w * s + h * c), 1) * 0.98;
    this.pin(w / 2, h / 2, vw / 2, vh / 2);
    this.requestDraw();
  }

  /** Zoom keeping the image point under (cx, cy) fixed. */
  zoomAt(newScale: number, cx: number, cy: number) {
    newScale = Math.min(64, Math.max(0.01, newScale));
    const [ix, iy] = this.viewToImage(cx, cy);
    this.scale = newScale;
    this.pin(ix, iy, cx, cy);
    this.requestDraw();
  }

  /** Rotates the view around the centre of the canvas. */
  rotateTo(deg: number) {
    deg = ((deg % 360) + 540) % 360 - 180; // -180 < deg <= 180
    if (Math.abs(deg) < 1e-9) deg = 0;
    const cx = this.viewWidth / 2, cy = this.viewHeight / 2;
    const [ix, iy] = this.viewToImage(cx, cy);
    this.rotation = deg;
    this.pin(ix, iy, cx, cy);
    this.requestDraw();
  }

  /** Mirrors the view left-right around the centre of the canvas. */
  setFlip(flip: boolean) {
    const cx = this.viewWidth / 2, cy = this.viewHeight / 2;
    const [ix, iy] = this.viewToImage(cx, cy);
    this.flipX = flip;
    this.pin(ix, iy, cx, cy);
    this.requestDraw();
  }

  /** Moves the view so that image point (ix, iy) is in the centre of the canvas. */
  centerOn(ix: number, iy: number) {
    this.pin(ix, iy, this.viewWidth / 2, this.viewHeight / 2);
    this.requestDraw();
  }

  panBy(dx: number, dy: number) {
    this.offsetX += dx;
    this.offsetY += dy;
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
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.118, 0.118, 0.118, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.hasImage) {
      this.drawSet(this.active!, this.matrix, this.viewWidth, this.viewHeight, window.devicePixelRatio || 1, this.scale >= 2);
    }
    this.lastDrawMs = performance.now() - t0;
    for (const fn of this.frameListeners) fn();
  }

  private drawSet(set: TextureSet, m: Affine, cssW: number, cssH: number, dpr: number, nearest: boolean) {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniform3f(this.loc.u_mx, m[0], m[1], m[2]);
    gl.uniform3f(this.loc.u_my, m[3], m[4], m[5]);
    gl.uniform2f(this.loc.u_canvas, cssW, cssH);
    gl.uniform1f(this.loc.u_dpr, dpr);
    gl.uniform1i(this.loc.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindSampler(0, nearest ? this.nearestSampler : this.smoothSampler);
    for (const t of set.tiles) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform4f(this.loc.u_rect, t.x, t.y, t.w, t.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
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
    this.drawSet(set, [w / set.width, 0, 0, 0, h / set.height, 0], w, h, 0.5, false);
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
