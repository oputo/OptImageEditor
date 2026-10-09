// GPU layer compositor (phase 2-a): renders a PSD layer tree into a premultiplied RGBA8 TextureSet.
//
// The document is processed in tiles of TILE x TILE px. Per tile, layers are composited into float
// buffers (RGBA16F when renderable, else RGBA8) with one full-tile pass per layer:
//   out = blend(backdrop, layer) — every pass reads the previous buffer and writes a fresh one.
// Compositing model (W3C compositing spec, which follows Photoshop / PDF):
//   Cs' = (1 - ab) * Cs + ab * B(Cb, Cs)          (B = blend mode, straight colours)
//   over: co = as * Cs' + (1 - as) * cb,  ao = as + ab * (1 - as)      (cb, co premultiplied)
//   as = layer alpha * mask * opacity * fill
// Groups: "pass through" composites the children onto a copy of the backdrop and mixes the result
// with the backdrop by the group's opacity / mask; other modes composite the children into a
// transparent buffer that is then blended like a layer. Clipping masks: the base layer (with its fill,
// not its opacity) goes into a transparent buffer, clipped layers are composited "atop" it, and the
// result is blended with the base's mode and opacity.
// Formulas checked against Photoshop's own composite of tools/ps_blend_test.jsx (36 cells, PS 27.10):
// all modes within 0-3 of 255 except dissolve (Photoshop's noise pattern is not reproduced). Findings:
//  - soft light is the W3C formula; vivid light tests the source extremes first (s = 0 -> 0, s = 1 -> 1)
//  - hard mix = clamp((b + F*s - F) / (1 - F)) with F = min(fill, 254.5/255) (ties go to the backdrop)
//  - "special 8" modes (colour / linear burn, colour / linear dodge, vivid / linear light, hard mix,
//    difference): fill does not scale alpha; it moves the source colour towards the mode's neutral colour
//    (checked for colour burn, linear dodge, hard mix; the others follow the same rule — inferred)
//  - clipped layers blend with the base colour as if it were opaque, then take the base's alpha
// Text layers are blended in a gamma 1.45 space (Photoshop's colour setting "Blend Text Colors Using
// Gamma 1.45"; inferred from comparing with Photoshop's own composite: mean error 22.9 -> 2.8 on a sample).
// Layer textures are sampled with texelFetch at integer document px (no filtering).
import type { DocLayer, LayerBlendMode, PsdDocData } from "./psdDoc";
import type { Renderer, TextureSet } from "./renderer";

const TILE = 2048;
/** Photoshop: Color Settings > Advanced > "Blend Text Colors Using Gamma" (1.45) */
const TEXT_GAMMA = 1.45;

const MODE_ID: Record<string, number> = {
  normal: 0, dissolve: 1, darken: 2, multiply: 3, "color burn": 4, "linear burn": 5, "darker color": 6,
  lighten: 7, screen: 8, "color dodge": 9, "linear dodge": 10, "lighter color": 11,
  overlay: 12, "soft light": 13, "hard light": 14, "vivid light": 15, "linear light": 16, "pin light": 17, "hard mix": 18,
  difference: 19, exclusion: 20, subtract: 21, divide: 22, hue: 23, saturation: 24, color: 25, luminosity: 26,
};

const VS = `#version 300 es
in vec2 a_unit;
void main() { gl_Position = vec4(a_unit * 2.0 - 1.0, 0.0, 1.0); }`;

const FS_PASS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_back;   // tile buffer (premultiplied)
uniform highp sampler2D u_src;    // layer texture (straight RGBA8) or tile buffer (premultiplied)
uniform highp sampler2D u_mask;   // R8
uniform bool u_srcIsBuf;
uniform ivec4 u_srcRect;          // layer rectangle in document px (x, y, w, h)
uniform bool u_hasMask;
uniform ivec4 u_maskRect;
uniform float u_maskDefault;
uniform ivec2 u_origin;           // document px of the tile's (0, 0)
uniform int u_mode;
uniform float u_alpha;            // opacity * fill
uniform int u_compose;            // 0 = over, 1 = atop (clipped layer), 2 = mix(backdrop, src, alpha * mask)
uniform float u_gamma;            // 1.0, or 1.45 for text layers
uniform float u_fill;             // fill ("塗り") for the special modes (others get it through u_alpha)
out vec4 o;

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c), n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  if (mx <= mn) return vec3(0.0);
  return (c - mn) * s / (mx - mn);
}
float dodge(float b, float s) { return b <= 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s))); }
float burn(float b, float s) { return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s)); }
float softLight(float b, float s) {   // W3C formula (matches Photoshop)
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (d - b);
}
float hardLight(float b, float s) { return s <= 0.5 ? b * 2.0 * s : 1.0 - (1.0 - b) * (1.0 - (2.0 * s - 1.0)); }
float vivid(float b, float s) {
  if (s <= 0.0) return 0.0;
  if (s >= 1.0) return 1.0;
  return s <= 0.5 ? 1.0 - min(1.0, (1.0 - b) / (2.0 * s)) : min(1.0, b / (2.0 * (1.0 - s)));
}
float hardMix(float b, float s) {
  float f = min(u_fill, 254.5 / 255.0);
  return clamp((b + f * s - f) / (1.0 - f), 0.0, 1.0);
}

vec3 blend(int m, vec3 b, vec3 s) {
  switch (m) {
    case 2: return min(b, s);
    case 3: return b * s;
    case 4: return vec3(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b));
    case 5: return max(b + s - 1.0, 0.0);
    case 6: return lum(s) < lum(b) ? s : b;
    case 7: return max(b, s);
    case 8: return b + s - b * s;
    case 9: return vec3(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b));
    case 10: return min(b + s, 1.0);
    case 11: return lum(s) > lum(b) ? s : b;
    case 12: return vec3(hardLight(s.r, b.r), hardLight(s.g, b.g), hardLight(s.b, b.b));
    case 13: return vec3(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b));
    case 14: return vec3(hardLight(b.r, s.r), hardLight(b.g, s.g), hardLight(b.b, s.b));
    case 15: return vec3(vivid(b.r, s.r), vivid(b.g, s.g), vivid(b.b, s.b));
    case 16: return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
    case 17: return vec3(s.r <= 0.5 ? min(b.r, 2.0 * s.r) : max(b.r, 2.0 * s.r - 1.0),
                         s.g <= 0.5 ? min(b.g, 2.0 * s.g) : max(b.g, 2.0 * s.g - 1.0),
                         s.b <= 0.5 ? min(b.b, 2.0 * s.b) : max(b.b, 2.0 * s.b - 1.0));
    case 18: return vec3(hardMix(b.r, s.r), hardMix(b.g, s.g), hardMix(b.b, s.b));
    case 19: return abs(b - s);
    case 20: return b + s - 2.0 * b * s;
    case 21: return max(b - s, 0.0);
    case 22: return vec3(s.r <= 0.0 ? (b.r <= 0.0 ? 0.0 : 1.0) : min(1.0, b.r / s.r),
                         s.g <= 0.0 ? (b.g <= 0.0 ? 0.0 : 1.0) : min(1.0, b.g / s.g),
                         s.b <= 0.0 ? (b.b <= 0.0 ? 0.0 : 1.0) : min(1.0, b.b / s.b));
    case 23: return setLum(setSat(s, sat(b)), lum(b));
    case 24: return setLum(setSat(b, sat(s)), lum(b));
    case 25: return setLum(s, lum(b));
    case 26: return setLum(b, lum(s));
    default: return s;  // normal, dissolve
  }
}

float hash(ivec2 p) {
  uvec2 q = uvec2(p) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n >> 8) / 16777216.0;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 d = u_origin + p;
  vec4 b = texelFetch(u_back, p, 0);
  float m = 1.0;
  if (u_hasMask) {
    ivec2 q = d - u_maskRect.xy;
    m = (q.x >= 0 && q.y >= 0 && q.x < u_maskRect.z && q.y < u_maskRect.w) ? texelFetch(u_mask, q, 0).r : u_maskDefault;
  }
  if (u_compose == 2) { o = mix(b, texelFetch(u_src, p, 0), u_alpha * m); return; }
  vec4 s = vec4(0.0);
  if (u_srcIsBuf) {
    vec4 sp = texelFetch(u_src, p, 0);
    s = sp.a > 0.0 ? vec4(sp.rgb / sp.a, sp.a) : vec4(0.0);
  } else {
    ivec2 q = d - u_srcRect.xy;
    if (q.x >= 0 && q.y >= 0 && q.x < u_srcRect.z && q.y < u_srcRect.w) s = texelFetch(u_src, q, 0);
  }
  float as = s.a * m * u_alpha;
  if (u_mode == 1) as = hash(d) < as ? 1.0 : 0.0;
  float ab = b.a;
  vec3 cb = ab > 0.0 ? b.rgb / ab : vec3(0.0);
  vec3 cs = s.rgb;
  if (u_gamma != 1.0) { cb = pow(cb, vec3(u_gamma)); cs = pow(cs, vec3(u_gamma)); }
  // special modes: fill pulls the source towards the neutral colour (hard mix uses u_fill in its formula)
  if (u_mode == 4 || u_mode == 5) cs = mix(vec3(1.0), cs, u_fill);
  else if (u_mode == 9 || u_mode == 10 || u_mode == 19) cs = mix(vec3(0.0), cs, u_fill);
  else if (u_mode == 15 || u_mode == 16) cs = mix(vec3(0.5), cs, u_fill);
  vec3 bl = clamp(blend(u_mode, cb, cs), 0.0, 1.0);
  // clipped layers (atop) blend with the base colour as if it were opaque
  vec3 cs2 = u_compose == 1 ? bl : (1.0 - ab) * cs + ab * bl;
  float ao = u_compose == 1 ? ab : as + ab * (1.0 - as);
  vec3 co = (u_compose == 1 ? as * cs2 * ab : as * cs2) + (1.0 - as) * ab * cb;   // premultiplied
  if (u_gamma != 1.0 && ao > 0.0) co = pow(co / ao, vec3(1.0 / u_gamma)) * ao;
  o = vec4(co, ao);
}`;

// copies a tile buffer (premultiplied float) into an RGBA8 texture, or clears to transparent
const FS_COPY = `#version 300 es
precision highp float;
uniform highp sampler2D u_src;
uniform bool u_clear;
out vec4 o;
void main() { o = u_clear ? vec4(0.0) : texelFetch(u_src, ivec2(gl_FragCoord.xy), 0); }`;

type Buf = { tex: WebGLTexture; fb: WebGLFramebuffer };

/** Photoshop's "special 8" modes: fill acts on the colour, not on the alpha */
const SPECIAL = new Set<LayerBlendMode>(["color burn", "linear burn", "color dodge", "linear dodge", "vivid light", "linear light", "hard mix", "difference"]);
const fillSplit = (l: DocLayer) =>
  SPECIAL.has(l.blendMode) ? { alpha: l.opacity, fill: l.fill } : { alpha: l.opacity * l.fill, fill: 1 };
type GpuLayer = { tex: WebGLTexture | null; mask: WebGLTexture | null };

/** GPU resources of one document. */
export class LayerDoc {
  readonly gpu = new Map<number, GpuLayer>();
  output: TextureSet | null = null;
  /** time of the last full composite (ms, GPU-synchronised) */
  lastMs = 0;
  passes = 0;
  /** next id for layers created in the app */
  nextId: number;
  constructor(readonly data: PsdDocData) {
    let max = data.count;
    const walk = (ls: PsdDocData["layers"]) => { for (const l of ls) { max = Math.max(max, l.id); if (l.children) walk(l.children); } };
    walk(data.layers);
    this.nextId = max + 1;
  }
}

export class Compositor {
  private gl: WebGL2RenderingContext;
  private passProg: WebGLProgram;
  private copyProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private cloc: Record<string, WebGLUniformLocation | null> = {};
  private pool: Buf[] = [];
  private bufFormat: number;
  private dummy: WebGLTexture;

  constructor(private renderer: Renderer) {
    const gl = (this.gl = renderer.gl);
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
    this.passProg = prog(FS_PASS);
    this.copyProg = prog(FS_COPY);
    for (const n of ["u_back", "u_src", "u_mask", "u_srcIsBuf", "u_srcRect", "u_hasMask", "u_maskRect", "u_maskDefault", "u_origin", "u_mode", "u_alpha", "u_compose", "u_gamma", "u_fill"]) {
      this.loc[n] = gl.getUniformLocation(this.passProg, n);
    }
    for (const n of ["u_src", "u_clear"]) this.cloc[n] = gl.getUniformLocation(this.copyProg, n);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.bufFormat = renderer.floatRenderable ? gl.RGBA16F : gl.RGBA8;
    this.dummy = this.texture(gl.R8, 1, 1);
  }

  private texture(format: number, w: number, h: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  }

  /** Uploads layer pixels and masks to the GPU; CPU copies are dropped afterwards. */
  upload(data: PsdDocData): LayerDoc {
    const gl = this.gl;
    const doc = new LayerDoc(data);
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const visit = (layers: DocLayer[]) => {
      for (const l of layers) {
        const g: GpuLayer = { tex: null, mask: null };
        if (l.pixels && l.w > 0 && l.h > 0) {
          if (l.w > max || l.h > max) l.warnings.push(`レイヤーが GPU の上限 ${max}px を超えるため表示できない`);
          else {
            g.tex = this.texture(gl.RGBA8, l.w, l.h);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, l.w, l.h, gl.RGBA, gl.UNSIGNED_BYTE, l.pixels);
          }
        }
        l.pixels = null;
        if (l.mask?.pixels && l.mask.w > 0 && l.mask.h > 0 && l.mask.w <= max && l.mask.h <= max) {
          g.mask = this.texture(gl.R8, l.mask.w, l.mask.h);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, l.mask.w, l.mask.h, gl.RED, gl.UNSIGNED_BYTE, l.mask.pixels);
          l.mask.pixels = null;
        }
        doc.gpu.set(l.id, g);
        if (l.children) visit(l.children);
      }
    };
    visit(data.layers);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    return doc;
  }

  dispose(doc: LayerDoc) {
    const gl = this.gl;
    const seen = new Set<WebGLTexture>(); // duplicated layers share their source's textures
    for (const g of doc.gpu.values()) {
      for (const t of [g.tex, g.mask]) if (t && !seen.has(t)) { seen.add(t); gl.deleteTexture(t); }
    }
    doc.gpu.clear();
    if (doc.output) this.renderer.dispose(doc.output);
    doc.output = null;
  }

  /** Frees the pooled tile buffers (call when no document is open any more). */
  trim() {
    for (const b of this.pool) { this.gl.deleteTexture(b.tex); this.gl.deleteFramebuffer(b.fb); }
    this.pool = [];
  }

  // ---------------------------------------------------------------- rendering

  private acquire(): Buf {
    const b = this.pool.pop();
    if (b) return b;
    const gl = this.gl;
    const tex = this.texture(this.bufFormat, TILE, TILE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb };
  }
  private release(b: Buf) { this.pool.push(b); }

  // per-render state
  private doc!: LayerDoc;
  private origin: [number, number] = [0, 0];
  private size: [number, number] = [TILE, TILE];

  private clear(): Buf {
    // gl.clear, not a draw: a draw is rejected ("feedback loop") when the pooled texture is still bound to a unit
    const gl = this.gl;
    const b = this.acquire();
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb);
    gl.viewport(0, 0, this.size[0], this.size[1]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return b;
  }

  private copy(src: Buf): Buf {
    const gl = this.gl;
    const b = this.acquire();
    gl.useProgram(this.copyProg);
    gl.uniform1i(this.cloc.u_clear, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(this.cloc.u_src, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb);
    gl.viewport(0, 0, this.size[0], this.size[1]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return b;
  }

  /** One composite pass; consumes `back` and returns the result buffer. */
  private pass(back: Buf, o: {
    layer?: DocLayer; buf?: Buf; mode: LayerBlendMode; alpha: number; compose: 0 | 1 | 2; mask?: DocLayer | null; fill?: number;
  }): Buf {
    const gl = this.gl;
    const out = this.acquire();
    gl.useProgram(this.passProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
    gl.viewport(0, 0, this.size[0], this.size[1]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, back.tex);
    gl.uniform1i(this.loc.u_back, 0);
    gl.activeTexture(gl.TEXTURE1);
    if (o.buf) {
      gl.bindTexture(gl.TEXTURE_2D, o.buf.tex);
      gl.uniform1i(this.loc.u_srcIsBuf, 1);
    } else {
      const g = this.doc.gpu.get(o.layer!.id);
      gl.bindTexture(gl.TEXTURE_2D, g?.tex ?? this.dummy);
      gl.uniform1i(this.loc.u_srcIsBuf, 0);
      const l = o.layer!;
      gl.uniform4i(this.loc.u_srcRect, l.x, l.y, g?.tex ? l.w : 0, g?.tex ? l.h : 0);
    }
    gl.uniform1i(this.loc.u_src, 1);
    // mask
    const ml = o.mask;
    const mk = ml?.mask && !ml.mask.disabled ? ml.mask : null;
    gl.activeTexture(gl.TEXTURE2);
    const mtex = mk ? this.doc.gpu.get(ml!.id)?.mask ?? null : null;
    gl.bindTexture(gl.TEXTURE_2D, mtex ?? this.dummy);
    gl.uniform1i(this.loc.u_mask, 2);
    gl.uniform1i(this.loc.u_hasMask, mk ? 1 : 0);
    if (mk) {
      gl.uniform4i(this.loc.u_maskRect, mk.x, mk.y, mtex ? mk.w : 0, mtex ? mk.h : 0);
      gl.uniform1f(this.loc.u_maskDefault, mk.defaultColor / 255);
    }
    gl.uniform2i(this.loc.u_origin, this.origin[0], this.origin[1]);
    gl.uniform1i(this.loc.u_mode, MODE_ID[o.mode] ?? 0);
    gl.uniform1f(this.loc.u_alpha, o.alpha);
    gl.uniform1i(this.loc.u_compose, o.compose);
    gl.uniform1f(this.loc.u_gamma, o.layer?.kind === "text" ? TEXT_GAMMA : 1);
    gl.uniform1f(this.loc.u_fill, o.fill ?? 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.doc.passes++;
    this.release(back);
    return out;
  }

  private intersects(l: DocLayer): boolean {
    const [ox, oy] = this.origin, [w, h] = this.size;
    return l.x < ox + w && l.x + l.w > ox && l.y < oy + h && l.y + l.h > oy;
  }

  /** Composites `layers` (bottom -> top) onto `acc`. */
  private list(layers: DocLayer[], acc: Buf): Buf {
    let i = 0;
    while (i < layers.length) {
      const node = layers[i];
      let j = i + 1;
      const clips: DocLayer[] = [];
      while (j < layers.length && layers[j].clipping) clips.push(layers[j++]);
      i = j;
      if (node.hidden) continue; // clipped layers disappear with their base
      const visibleClips = clips.filter((c) => !c.hidden);
      if (node.children) {
        acc = this.group(node, acc, visibleClips);
      } else if (node.kind === "adjustment") {
        continue; // not rendered yet (phase 4)
      } else if (visibleClips.length) {
        let g = this.clear();
        if (this.intersects(node)) g = this.pass(g, { layer: node, mode: "normal", alpha: node.fill, compose: 0, mask: node });
        for (const c of visibleClips) g = this.clipped(c, g);
        acc = this.pass(acc, { buf: g, mode: node.blendMode, alpha: node.opacity, compose: 0 });
        this.release(g);
      } else if (this.intersects(node)) {
        acc = this.pass(acc, { layer: node, mode: node.blendMode, ...fillSplit(node), compose: 0, mask: node });
      }
    }
    return acc;
  }

  /** A clipped layer (or group) composited atop the clipping base buffer `g`. */
  private clipped(c: DocLayer, g: Buf): Buf {
    if (c.children) {
      let inner = c.blendMode === "pass through" ? this.copy(g) : this.clear();
      inner = this.list(c.children, inner);
      g = this.pass(g, { buf: inner, mode: c.blendMode === "pass through" ? "normal" : c.blendMode, alpha: c.opacity, compose: 1, mask: c });
      this.release(inner);
      return g;
    }
    if (c.kind === "adjustment" || !this.intersects(c)) return g;
    return this.pass(g, { layer: c, mode: c.blendMode, ...fillSplit(c), compose: 1, mask: c });
  }

  private group(node: DocLayer, acc: Buf, clips: DocLayer[]): Buf {
    const children = node.children!;
    if (node.blendMode === "pass through" && !clips.length) {
      let child = this.copy(acc);
      child = this.list(children, child);
      const hasMask = !!node.mask && !node.mask.disabled;
      if (node.opacity >= 1 && !hasMask) { this.release(acc); return child; }
      acc = this.pass(acc, { buf: child, mode: "normal", alpha: node.opacity, compose: 2, mask: node });
      this.release(child);
      return acc;
    }
    // isolated group (or a group used as a clipping base)
    let g = this.clear();
    g = this.list(children, g);
    if (clips.length) for (const c of clips) g = this.clipped(c, g);
    const mode = node.blendMode === "pass through" ? "normal" : node.blendMode;
    acc = this.pass(acc, { buf: g, mode, alpha: node.opacity, compose: 0, mask: node });
    this.release(g);
    return acc;
  }

  /** Renders the whole document into `doc.output` (created on first use). `layers` defaults to the loaded tree
   *  (pass the UI's reactive tree so property changes are picked up). */
  render(doc: LayerDoc, layers: DocLayer[] = doc.data.layers): TextureSet {
    const { width: W, height: H } = doc.data;
    if (!doc.output) doc.output = this.createOutput(W, H);
    return this.renderInto(doc, layers, doc.output);
  }

  /** Renders `layers` into a new, transparent document-size TextureSet (merging). Dispose it with renderer.dispose. */
  renderSeparate(doc: LayerDoc, layers: DocLayer[]): TextureSet {
    return this.renderInto(doc, layers, this.createOutput(doc.data.width, doc.data.height));
  }

  private renderInto(doc: LayerDoc, layers: DocLayer[], output: TextureSet): TextureSet {
    const gl = this.gl;
    const t0 = performance.now();
    this.doc = doc;
    doc.passes = 0;
    // the renderer's samplers would make these textures incomplete for texelFetch
    for (let u = 0; u < 3; u++) gl.bindSampler(u, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);
    for (const t of output.tiles) {
      this.origin = [t.x, t.y];
      this.size = [t.w, t.h];
      let acc = this.clear();
      acc = this.list(layers, acc);
      // write into the output tile (RGBA8, premultiplied) and rebuild its mipmaps
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      gl.useProgram(this.copyProg);
      gl.uniform1i(this.cloc.u_clear, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, acc.tex);
      gl.uniform1i(this.cloc.u_src, 1);
      gl.viewport(0, 0, t.w, t.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.deleteFramebuffer(fb);
      this.release(acc);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // GPU sync for the timing
    doc.lastMs = performance.now() - t0;
    this.renderer.requestDraw();
    return output;
  }

  // ---------------------------------------------------------------- pixels made in the app (phase 2-c)

  /** Gives layer `id` new pixels (straight RGBA, w x h; the layer rectangle is on the DocLayer). */
  setLayerPixels(doc: LayerDoc, id: number, rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, mask: WebGLTexture | null = null) {
    const gl = this.gl;
    const g: GpuLayer = { tex: null, mask };
    if (w > 0 && h > 0) {
      g.tex = this.texture(gl.RGBA8, w, h);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    }
    doc.gpu.set(id, g);
  }

  /** Straight RGBA pixels of layer `id` (w x h), read back from its texture. */
  readLayerPixels(doc: LayerDoc, id: number, w: number, h: number): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(w * h * 4);
    const tex = doc.gpu.get(id)?.tex;
    if (!tex || w <= 0 || h <= 0) return out;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return out;
  }

  /** Frees the GPU data of layers that are neither in the tree nor in the undo history (`keep`). */
  releaseUnused(doc: LayerDoc, keep: Set<number>) {
    const gl = this.gl;
    const used = new Set<WebGLTexture>();
    for (const [id, g] of doc.gpu) if (keep.has(id)) { if (g.tex) used.add(g.tex); if (g.mask) used.add(g.mask); }
    for (const [id, g] of [...doc.gpu]) {
      if (keep.has(id)) continue;
      for (const t of [g.tex, g.mask]) if (t && !used.has(t)) { used.add(t); gl.deleteTexture(t); }
      doc.gpu.delete(id);
    }
  }

  private createOutput(W: number, H: number): TextureSet {
    const gl = this.gl;
    const tiles: TextureSet["tiles"] = [];
    let bytes = 0;
    for (let y = 0; y < H; y += TILE) {
      for (let x = 0; x < W; x += TILE) {
        const w = Math.min(TILE, W - x), h = Math.min(TILE, H - y);
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(w, h))) + 1, gl.RGBA8, w, h);
        tiles.push({ tex, x, y, w, h });
        bytes += Math.round(w * h * 4 * 4 / 3);
      }
    }
    return this.renderer.adopt({ tiles, width: W, height: H, bytes, hdr: false, mips: true });
  }
}
