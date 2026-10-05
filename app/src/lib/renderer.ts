// WebGL2 image renderer: tiled textures (images larger than MAX_TEXTURE_SIZE are split),
// mipmapped minification, nearest-neighbour when zoomed in >= 200%, checkerboard behind transparency.

const VS = `#version 300 es
in vec2 a_unit;                 // 0..1 quad
uniform vec4 u_rect;            // tile rect in image px (x, y, w, h)
uniform vec3 u_view;            // scale (css px per image px), offsetX, offsetY (css px)
uniform vec2 u_canvas;          // canvas size in css px
out vec2 v_uv;
void main() {
  vec2 img = u_rect.xy + a_unit * u_rect.zw;
  vec2 css = img * u_view.x + u_view.yz;
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
  private tiles: Tile[] = [];
  imageWidth = 0;
  imageHeight = 0;
  textureBytes = 0;
  // view: css px per image px, and image origin position in css px
  scale = 1;
  offsetX = 0;
  offsetY = 0;
  private rafPending = false;

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
    for (const n of ["u_rect", "u_view", "u_canvas", "u_tex", "u_dpr"]) this.loc[n] = gl.getUniformLocation(p, n);

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

  get hasImage() { return this.tiles.length > 0; }

  clear() {
    for (const t of this.tiles) this.gl.deleteTexture(t.tex);
    this.tiles = [];
    this.textureBytes = 0;
    this.imageWidth = this.imageHeight = 0;
  }

  /** Uploads the image as one or more tiles. Returns upload time in ms (GPU-synchronised). */
  async setImage(src: ImageSource): Promise<number> {
    const gl = this.gl;
    this.clear();
    const t0 = performance.now();
    const T = Math.min(this.maxTextureSize, 8192);
    this.imageWidth = src.width;
    this.imageHeight = src.height;

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
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, part);
          if (part !== src.bitmap) part.close();
        }
        gl.generateMipmap(gl.TEXTURE_2D);
        this.tiles.push({ tex, x, y, w, h });
        this.textureBytes += Math.round(w * h * 4 * 4 / 3);
      }
    }
    if (src.kind === "bitmap") src.bitmap.close();
    // force GPU sync so the measured time includes the upload
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return performance.now() - t0;
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

  fit() {
    if (!this.hasImage) return;
    const vw = this.viewWidth, vh = this.viewHeight;
    this.scale = Math.min(vw / this.imageWidth, vh / this.imageHeight, 1) * 0.98;
    this.offsetX = (vw - this.imageWidth * this.scale) / 2;
    this.offsetY = (vh - this.imageHeight * this.scale) / 2;
    this.requestDraw();
  }

  /** Zoom keeping the image point under (cx, cy) fixed. */
  zoomAt(newScale: number, cx: number, cy: number) {
    newScale = Math.min(64, Math.max(0.01, newScale));
    const ix = (cx - this.offsetX) / this.scale;
    const iy = (cy - this.offsetY) / this.scale;
    this.scale = newScale;
    this.offsetX = cx - ix * newScale;
    this.offsetY = cy - iy * newScale;
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
    if (!this.hasImage) return;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniform3f(this.loc.u_view, this.scale, this.offsetX, this.offsetY);
    gl.uniform2f(this.loc.u_canvas, this.viewWidth, this.viewHeight);
    gl.uniform1f(this.loc.u_dpr, window.devicePixelRatio || 1);
    gl.uniform1i(this.loc.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindSampler(0, this.scale >= 2 ? this.nearestSampler : this.smoothSampler);
    for (const t of this.tiles) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform4f(this.loc.u_rect, t.x, t.y, t.w, t.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    this.lastDrawMs = performance.now() - t0;
  }
}
