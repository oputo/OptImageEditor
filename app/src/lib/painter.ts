// Brush strokes on the GPU (phase 3-b). A stroke paints into a layer texture (straight RGBA8) or a mask texture (R8)
// in place:
//   1. at the start the target is copied (`orig`) and a coverage buffer (R8, `cov`) is cleared;
//   2. every dab is drawn into `cov` with MAX blending (dabs of one stroke do not build up: the stroke's opacity is
//      the ceiling, like Photoshop with flow 100 %);
//   3. per frame the touched rectangle of the target is rebuilt from `orig`, `cov`, the colour and the selection;
//   4. at the end the changed 256 px tiles (before / after) are read back for the undo history.
// Coordinates: target texture px (the caller converts canvas px; the target's origin is at canvas (ox, oy)).

export type Rect = { x: number; y: number; w: number; h: number };
/** pixels of the target before / after a stroke, per changed tile (bpp 4: RGBA, 1: mask) */
export type PatchTile = { x: number; y: number; w: number; h: number; before: Uint8Array; after: Uint8Array };
export type StrokeTarget = {
  tex: WebGLTexture; w: number; h: number; mask: boolean;
  /** canvas position of the target's pixel (0, 0) */
  ox: number; oy: number;
};
export type StrokeStyle = {
  /** straight RGB 0..1 */
  color: [number, number, number];
  opacity: number;
  eraser: boolean;
  /** keep the alpha (transparency lock / background layer); the eraser then paints `color` (the background colour) */
  keepAlpha: boolean;
};

const TILE = 256;

const VS = `#version 300 es
in vec2 a_unit;
uniform vec4 u_rect;   // x, y, w, h in target px
uniform vec2 u_size;   // target size
out vec2 v_px;
void main() {
  vec2 px = u_rect.xy + a_unit * u_rect.zw;
  v_px = px;
  gl_Position = vec4(px / u_size * 2.0 - 1.0, 0.0, 1.0);
}`;

// coverage of one dab: 1 inside the hard core, smooth falloff to the radius (at least 1 px of anti-aliasing)
const FS_DAB = `#version 300 es
precision highp float;
in vec2 v_px;
uniform vec2 u_center;
uniform float u_radius;
uniform float u_hard;
uniform float u_alpha;
out vec4 o;
void main() {
  float d = length(v_px - u_center);
  float inner = min(u_radius * u_hard, u_radius - 1.0);
  float c = 1.0 - smoothstep(inner, u_radius, d);
  o = vec4(c * u_alpha, 0.0, 0.0, 1.0);
}`;

const FS_APPLY = `#version 300 es
precision highp float;
uniform sampler2D u_orig;
uniform sampler2D u_cov;
uniform sampler2D u_sel;
uniform bool u_hasSel;
uniform ivec4 u_selRect;   // in target px
uniform bool u_mask;
uniform bool u_eraser;
uniform bool u_keepAlpha;
uniform vec3 u_color;
uniform float u_opacity;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 b = texelFetch(u_orig, p, 0);
  float s = texelFetch(u_cov, p, 0).r * u_opacity;
  if (u_hasSel) {
    ivec2 q = p - u_selRect.xy;
    s *= (q.x >= 0 && q.y >= 0 && q.x < u_selRect.z && q.y < u_selRect.w) ? texelFetch(u_sel, q, 0).r : 0.0;
  }
  if (u_mask) {
    float g = dot(u_color, vec3(0.299, 0.587, 0.114));
    o = vec4(mix(b.r, g, s), 0.0, 0.0, 1.0);
    return;
  }
  if (u_keepAlpha) { o = vec4(mix(b.rgb, u_color, s), b.a); return; }
  if (u_eraser) { o = vec4(b.rgb, b.a * (1.0 - s)); return; }
  float a = s + b.a * (1.0 - s);
  vec3 c = a > 0.0 ? (u_color * s + b.rgb * b.a * (1.0 - s)) / a : u_color;
  o = vec4(c, a);
}`;

export class Painter {
  private dabProg: WebGLProgram;
  private applyProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private dl: Record<string, WebGLUniformLocation | null> = {};
  private al: Record<string, WebGLUniformLocation | null> = {};
  // per stroke
  private target: StrokeTarget | null = null;
  private style: StrokeStyle | null = null;
  private orig: WebGLTexture | null = null;
  private cov: WebGLTexture | null = null;
  private covFb: WebGLFramebuffer | null = null;
  private targetFb: WebGLFramebuffer | null = null;
  private sel: { tex: WebGLTexture; rect: Rect } | null = null;
  /** touched since the last apply / since the start */
  private pending: Rect | null = null;
  private touched: Rect | null = null;

  constructor(private gl: WebGL2RenderingContext) {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
      return s;
    };
    const prog = (fs: string) => {
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, "a_unit");
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
      return p;
    };
    this.dabProg = prog(FS_DAB);
    this.applyProg = prog(FS_APPLY);
    for (const n of ["u_rect", "u_size", "u_center", "u_radius", "u_hard", "u_alpha"]) this.dl[n] = gl.getUniformLocation(this.dabProg, n);
    for (const n of ["u_rect", "u_size", "u_orig", "u_cov", "u_sel", "u_hasSel", "u_selRect", "u_mask", "u_eraser", "u_keepAlpha", "u_color", "u_opacity"]) this.al[n] = gl.getUniformLocation(this.applyProg, n);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  get active() { return !!this.target; }

  private tex(format: number, w: number, h: number) {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private fbOf(tex: WebGLTexture) {
    const gl = this.gl;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return fb;
  }

  /** Starts a stroke. `sel`: selection mask (w x h values at target px rect), or null. */
  begin(target: StrokeTarget, style: StrokeStyle, sel: { rect: Rect; m: Uint8Array } | null) {
    const gl = this.gl;
    this.cancel();
    this.target = target;
    this.style = style;
    const fmt = target.mask ? gl.R8 : gl.RGBA8;
    this.targetFb = this.fbOf(target.tex);
    // the target before the stroke
    this.orig = this.tex(fmt, target.w, target.h);
    gl.bindTexture(gl.TEXTURE_2D, this.orig);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, target.w, target.h);
    this.cov = this.tex(gl.R8, target.w, target.h);
    this.covFb = this.fbOf(this.cov);
    gl.viewport(0, 0, target.w, target.h);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (sel && sel.rect.w > 0 && sel.rect.h > 0) {
      const t = this.tex(gl.R8, sel.rect.w, sel.rect.h);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sel.rect.w, sel.rect.h, gl.RED, gl.UNSIGNED_BYTE, sel.m);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      this.sel = { tex: t, rect: sel.rect };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pending = null;
    this.touched = null;
  }

  private grow(r: Rect | null, x: number, y: number, w: number, h: number): Rect {
    if (!r) return { x, y, w, h };
    const x0 = Math.min(r.x, x), y0 = Math.min(r.y, y);
    return { x: x0, y: y0, w: Math.max(r.x + r.w, x + w) - x0, h: Math.max(r.y + r.h, y + h) - y0 };
  }

  /** one dab at target px (cx, cy) */
  dab(cx: number, cy: number, radius: number, hardness: number, alpha: number) {
    const t = this.target;
    if (!t || radius <= 0) return;
    const gl = this.gl;
    const r = Math.max(0.5, radius);
    const x0 = Math.max(0, Math.floor(cx - r - 1)), y0 = Math.max(0, Math.floor(cy - r - 1));
    const x1 = Math.min(t.w, Math.ceil(cx + r + 1)), y1 = Math.min(t.h, Math.ceil(cy + r + 1));
    if (x1 <= x0 || y1 <= y0) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.covFb);
    gl.viewport(0, 0, t.w, t.h);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.dabProg);
    gl.bindVertexArray(this.vao);
    gl.uniform4f(this.dl.u_rect, x0, y0, x1 - x0, y1 - y0);
    gl.uniform2f(this.dl.u_size, t.w, t.h);
    gl.uniform2f(this.dl.u_center, cx, cy);
    gl.uniform1f(this.dl.u_radius, r);
    gl.uniform1f(this.dl.u_hard, hardness);
    gl.uniform1f(this.dl.u_alpha, alpha);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pending = this.grow(this.pending, x0, y0, x1 - x0, y1 - y0);
    this.touched = this.grow(this.touched, x0, y0, x1 - x0, y1 - y0);
  }

  /** Writes the dabs since the last call into the target. Returns the changed rectangle in canvas px (or null). */
  apply(): Rect | null {
    const t = this.target, st = this.style, r = this.pending;
    if (!t || !st || !r) return null;
    this.pending = null;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targetFb);
    gl.viewport(0, 0, t.w, t.h);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this.applyProg);
    gl.bindVertexArray(this.vao);
    for (let u = 0; u < 3; u++) gl.bindSampler(u, null);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.orig); gl.uniform1i(this.al.u_orig, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.cov); gl.uniform1i(this.al.u_cov, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.sel?.tex ?? this.cov); gl.uniform1i(this.al.u_sel, 2);
    gl.uniform1i(this.al.u_hasSel, this.sel ? 1 : 0);
    const sr = this.sel?.rect ?? { x: 0, y: 0, w: 0, h: 0 };
    gl.uniform4i(this.al.u_selRect, sr.x, sr.y, sr.w, sr.h);
    gl.uniform1i(this.al.u_mask, t.mask ? 1 : 0);
    gl.uniform1i(this.al.u_eraser, st.eraser ? 1 : 0);
    gl.uniform1i(this.al.u_keepAlpha, st.keepAlpha ? 1 : 0);
    gl.uniform3f(this.al.u_color, st.color[0], st.color[1], st.color[2]);
    gl.uniform1f(this.al.u_opacity, st.opacity);
    gl.uniform4f(this.al.u_rect, r.x, r.y, r.w, r.h);
    gl.uniform2f(this.al.u_size, t.w, t.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    return { x: r.x + t.ox, y: r.y + t.oy, w: r.w, h: r.h };
  }

  private read(fb: WebGLFramebuffer, x: number, y: number, w: number, h: number, mask: boolean): Uint8Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const rgba = new Uint8Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    if (!mask) return rgba;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4];
    return out;
  }

  /** Ends the stroke: the changed tiles (before / after) for the undo history, and their size in bytes. */
  end(): { tiles: PatchTile[]; bytes: number } {
    const t = this.target, r = this.touched;
    const tiles: PatchTile[] = [];
    let bytes = 0;
    if (t && r) {
      this.apply();
      const origFb = this.fbOf(this.orig!);
      const bpp = t.mask ? 1 : 4;
      for (let ty = Math.floor(r.y / TILE) * TILE; ty < r.y + r.h; ty += TILE) {
        for (let tx = Math.floor(r.x / TILE) * TILE; tx < r.x + r.w; tx += TILE) {
          const w = Math.min(TILE, t.w - tx), h = Math.min(TILE, t.h - ty);
          if (w <= 0 || h <= 0) continue;
          const before = this.read(origFb, tx, ty, w, h, t.mask);
          const after = this.read(this.targetFb!, tx, ty, w, h, t.mask);
          let same = true;
          for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) { same = false; break; }
          if (same) continue;
          tiles.push({ x: tx, y: ty, w, h, before, after });
          bytes += 2 * w * h * bpp;
        }
      }
      this.gl.deleteFramebuffer(origFb);
    }
    this.cancel();
    return { tiles, bytes };
  }

  /** frees the per-stroke resources (the target keeps what was applied) */
  cancel() {
    const gl = this.gl;
    for (const t of [this.orig, this.cov, this.sel?.tex]) if (t) gl.deleteTexture(t);
    for (const f of [this.covFb, this.targetFb]) if (f) gl.deleteFramebuffer(f);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.orig = this.cov = null;
    this.covFb = this.targetFb = null;
    this.sel = null;
    this.target = null;
    this.style = null;
    this.pending = this.touched = null;
  }
}

/** writes tiles (before or after) back into a texture */
export function applyTiles(gl: WebGL2RenderingContext, tex: WebGLTexture, mask: boolean, tiles: PatchTile[], which: "before" | "after") {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  for (const t of tiles) gl.texSubImage2D(gl.TEXTURE_2D, 0, t.x, t.y, t.w, t.h, mask ? gl.RED : gl.RGBA, gl.UNSIGNED_BYTE, t[which]);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
}
