// WebGL2 vector renderer: instanced anti-aliased line segments projected on the GPU,
// additive blending, bloom and phosphor persistence for the vector-CRT look.
import type { Xform } from './proj.ts';

const PROJ = `
uniform int u_kind; uniform float u_lon0; uniform vec2 u_c; uniform vec2 u_k; uniform vec2 u_vp; uniform float u_lift;
vec2 proj(vec2 ll) {
  if (u_kind == 0) { float x = mod(ll.x - u_lon0 + 180.0, 360.0) - 180.0; return vec2(x, -ll.y); }
  float r = 90.0 - ll.y; float th = radians(ll.x - u_lon0); return vec2(r * sin(th), r * cos(th));
}
vec2 toPx(vec2 p) { return u_vp * 0.5 + (p - u_c) * u_k; }
const vec2 CORNERS[6] = vec2[6](vec2(0.0,-1.0), vec2(1.0,-1.0), vec2(1.0,1.0), vec2(0.0,-1.0), vec2(1.0,1.0), vec2(0.0,1.0));
out vec2 v_local; out float v_len; out float v_hw;
vec4 quad(vec2 A, vec2 B, float w, bool bad) {
  vec2 d = B - A; float L = length(d);
  vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float hw = w * 0.5 + 1.5;
  vec2 c = CORNERS[gl_VertexID];
  vec2 P = mix(A - dir * hw, B + dir * hw, c.x) + n * hw * c.y;
  v_local = vec2(mix(-hw, L + hw, c.x), hw * c.y); v_len = L; v_hw = w * 0.5;
  if (bad) return vec4(2.0, 2.0, 2.0, 1.0);
  return vec4(P.x / u_vp.x * 2.0 - 1.0, 1.0 - P.y / u_vp.y * 2.0, 0.0, 1.0);
}`;

const GEO_VS = `#version 300 es
precision highp float;
in vec4 a_seg;
uniform float u_w;
${PROJ}
void main() {
  vec2 a = a_seg.xy, b = a_seg.zw;
  bool bad = u_kind == 1 && (a.y < -30.0 || b.y < -30.0);
  vec2 pa = proj(a), pb = proj(b);
  if (u_kind == 0 && abs(pa.x - pb.x) > 180.0) bad = true;
  gl_Position = quad(toPx(pa), toPx(pb), u_w, bad);
}`;

const DYN_VS = `#version 300 es
precision highp float;
in vec4 a_seg; in vec4 a_off; in vec4 a_col; in vec4 a_ext;
out vec4 v_col; flat out int v_flags;
${PROJ}
void main() {
  int flags = int(a_ext.w);
  bool screen = (flags & 1) != 0;
  bool bad = false;
  vec2 A, B;
  if (screen) { A = a_seg.xy; B = a_seg.zw; }
  else {
    bad = u_kind == 1 && (a_seg.y < -30.0 || a_seg.w < -30.0);
    vec2 pa = proj(a_seg.xy), pb = proj(a_seg.zw);
    if (u_kind == 0 && abs(pa.x - pb.x) > 180.0) bad = true;
    A = toPx(pa); B = toPx(pb);
    A.y -= a_ext.y * u_lift; B.y -= a_ext.z * u_lift;
  }
  A += a_off.xy; B += a_off.zw;
  v_col = a_col; v_flags = flags;
  gl_Position = quad(A, B, a_ext.x, bad);
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec2 v_local; in float v_len; in float v_hw;
uniform vec4 u_col;
out vec4 o;
void main() {
  float t = clamp(v_local.x, 0.0, v_len);
  float d = length(vec2(v_local.x - t, v_local.y));
  float a = 1.0 - smoothstep(v_hw - 0.4, v_hw + 1.1, d);
  o = vec4(u_col.rgb * u_col.a * a, a * u_col.a);
}`;

const DYN_FS = `#version 300 es
precision highp float;
in vec2 v_local; in float v_len; in float v_hw; in vec4 v_col; flat in int v_flags;
out vec4 o;
void main() {
  if ((v_flags & 2) != 0 && mod(v_local.x, 12.0) > 6.0) discard;
  float t = clamp(v_local.x, 0.0, v_len);
  float d = length(vec2(v_local.x - t, v_local.y));
  float a = 1.0 - smoothstep(v_hw - 0.4, v_hw + 1.1, d);
  o = vec4(v_col.rgb * v_col.a * a, a * v_col.a);
}`;

const FS_VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv; uniform sampler2D u_tex; out vec4 o;
void main() { o = texture(u_tex, v_uv); }`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv; uniform sampler2D u_tex; uniform vec2 u_dir; out vec4 o;
void main() {
  vec4 s = texture(u_tex, v_uv) * 0.2270270270;
  s += texture(u_tex, v_uv + u_dir * 1.3846153846) * 0.3162162162;
  s += texture(u_tex, v_uv - u_dir * 1.3846153846) * 0.3162162162;
  s += texture(u_tex, v_uv + u_dir * 3.2307692308) * 0.0702702703;
  s += texture(u_tex, v_uv - u_dir * 3.2307692308) * 0.0702702703;
  o = s;
}`;

const COMPOSE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_scene; uniform sampler2D u_b1; uniform sampler2D u_b2; uniform sampler2D u_prev;
uniform float u_bloom; uniform float u_decay;
out vec4 o;
void main() {
  vec3 c = texture(u_scene, v_uv).rgb + texture(u_b1, v_uv).rgb * (0.85 * u_bloom) + texture(u_b2, v_uv).rgb * (0.45 * u_bloom);
  vec3 p = texture(u_prev, v_uv).rgb * u_decay;
  o = vec4(max(c, p), 1.0);
}`;

const FINAL_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex; uniform float u_scan; uniform float u_exposure; uniform vec2 u_res;
out vec4 o;
void main() {
  vec3 c = texture(u_tex, v_uv).rgb;
  c = vec3(1.0) - exp(-c * u_exposure);
  float line = 0.5 + 0.5 * sin(v_uv.y * u_res.y * 3.14159);
  c *= mix(1.0, 0.82 + 0.18 * line, u_scan);
  vec2 q = v_uv - 0.5;
  c *= 1.0 - dot(q, q) * 0.35;
  o = vec4(c, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
  return s;
}

class Program {
  p: WebGLProgram;
  private u = new Map<string, WebGLUniformLocation | null>();
  constructor(private gl: WebGL2RenderingContext, vs: string, fs: string) {
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    this.p = p;
  }
  loc(name: string) {
    if (!this.u.has(name)) this.u.set(name, this.gl.getUniformLocation(this.p, name));
    return this.u.get(name)!;
  }
  attr(name: string) {
    return this.gl.getAttribLocation(this.p, name);
  }
}

interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

/** Dynamic segment batch, 16 floats per segment. */
export class DynBatch {
  data = new Float32Array(16 * 4096);
  n = 0;
  reset() { this.n = 0; }
  private grow() {
    const d = new Float32Array(this.data.length * 2);
    d.set(this.data);
    this.data = d;
  }
  /** geo segment (lat/lon endpoints) with optional px offsets / altitude lift */
  seg(lonA: number, latA: number, lonB: number, latB: number, col: number[], w = 1.5, flags = 0, oxA = 0, oyA = 0, oxB = 0, oyB = 0, altA = 0, altB = 0) {
    if ((this.n + 1) * 16 > this.data.length) this.grow();
    const d = this.data, o = this.n * 16;
    d[o] = lonA; d[o + 1] = latA; d[o + 2] = lonB; d[o + 3] = latB;
    d[o + 4] = oxA; d[o + 5] = oyA; d[o + 6] = oxB; d[o + 7] = oyB;
    d[o + 8] = col[0]; d[o + 9] = col[1]; d[o + 10] = col[2]; d[o + 11] = col[3] ?? 1;
    d[o + 12] = w; d[o + 13] = altA; d[o + 14] = altB; d[o + 15] = flags;
    this.n++;
  }
  /** screen-space segment in viewport px */
  px(x1: number, y1: number, x2: number, y2: number, col: number[], w = 1.5, flags = 0) {
    this.seg(x1, y1, x2, y2, col, w, flags | 1);
  }
}

export interface GeoBuffer {
  vbo: WebGLBuffer;
  starts: Int32Array; // per bucket
  counts: Int32Array;
  total: number;
}

export const LAT_BANDS = 18;
export const LON_BANDS = 36;

export interface FxSettings {
  bloom: number;
  persistence: number; // 0..1
  scanlines: number; // 0..1
  exposure: number;
}

export class Renderer {
  gl: WebGL2RenderingContext;
  private geoProg: Program;
  private dynProg: Program;
  private copy: Program;
  private blur: Program;
  private compose: Program;
  private final: Program;
  private geoVao: WebGLVertexArrayObject;
  private dynVao: WebGLVertexArrayObject;
  private dynVbo: WebGLBuffer;
  private emptyVao: WebGLVertexArrayObject;
  private scene!: Target;
  private half!: Target;
  private q1!: Target;
  private q2!: Target;
  private e1!: Target;
  private e2!: Target;
  private accum: Target[] = [];
  private cur = 0;
  private floatOk: boolean;
  w = 0;
  h = 0;

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.floatOk = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.geoProg = new Program(gl, GEO_VS, LINE_FS);
    this.dynProg = new Program(gl, DYN_VS, DYN_FS);
    this.copy = new Program(gl, FS_VS, COPY_FS);
    this.blur = new Program(gl, FS_VS, BLUR_FS);
    this.compose = new Program(gl, FS_VS, COMPOSE_FS);
    this.final = new Program(gl, FS_VS, FINAL_FS);
    this.geoVao = gl.createVertexArray()!;
    this.dynVao = gl.createVertexArray()!;
    this.emptyVao = gl.createVertexArray()!;
    this.dynVbo = gl.createBuffer()!;
    gl.bindVertexArray(this.dynVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynVbo);
    const names = ['a_seg', 'a_off', 'a_col', 'a_ext'];
    names.forEach((n, i) => {
      const loc = this.dynProg.attr(n);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 64, i * 16);
      gl.vertexAttribDivisor(loc, 1);
    });
    gl.bindVertexArray(this.geoVao);
    const gl0 = this.geoProg.attr('a_seg');
    gl.enableVertexAttribArray(gl0);
    gl.vertexAttribDivisor(gl0, 1);
    gl.bindVertexArray(null);
  }

  private target(w: number, h: number, old?: Target): Target {
    const gl = this.gl;
    if (old) { gl.deleteFramebuffer(old.fb); gl.deleteTexture(old.tex); }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.floatOk) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { fb, tex, w, h };
  }

  resize(w: number, h: number) {
    w = Math.max(8, w);
    h = Math.max(8, h);
    if (w === this.w && h === this.h && this.scene) return;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.scene = this.target(w, h, this.scene);
    this.half = this.target(w >> 1, h >> 1, this.half);
    this.q1 = this.target(w >> 2, h >> 2, this.q1);
    this.q2 = this.target(w >> 2, h >> 2, this.q2);
    this.e1 = this.target(w >> 3, h >> 3, this.e1);
    this.e2 = this.target(w >> 3, h >> 3, this.e2);
    this.accum = [this.target(w, h, this.accum[0]), this.target(w, h, this.accum[1])];
  }

  uploadGeo(segs: Float32Array, starts: Int32Array, counts: Int32Array): GeoBuffer {
    const gl = this.gl;
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, segs, gl.STATIC_DRAW);
    return { vbo, starts, counts, total: segs.length / 4 };
  }

  beginFrame() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fb);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
  }

  /** Select a panel viewport (top-left origin, device px). */
  panel(x: number, y: number, w: number, h: number) {
    const gl = this.gl;
    const gy = this.h - (y + h);
    gl.viewport(x, gy, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, gy, w, h);
  }

  private setXform(p: Program, xf: Xform, lift = 0) {
    const gl = this.gl;
    gl.uniform1i(p.loc('u_kind'), xf.kind);
    gl.uniform1f(p.loc('u_lon0'), xf.lon0);
    gl.uniform2f(p.loc('u_c'), xf.cx, xf.cy);
    gl.uniform2f(p.loc('u_k'), xf.kx, xf.ky);
    gl.uniform2f(p.loc('u_vp'), xf.w, xf.h);
    gl.uniform1f(p.loc('u_lift'), lift);
  }

  drawGeo(buf: GeoBuffer, ranges: [number, number][], xf: Xform, col: number[], width: number) {
    const gl = this.gl;
    gl.useProgram(this.geoProg.p);
    this.setXform(this.geoProg, xf);
    gl.uniform1f(this.geoProg.loc('u_w'), width);
    gl.uniform4f(this.geoProg.loc('u_col'), col[0], col[1], col[2], col[3] ?? 1);
    gl.bindVertexArray(this.geoVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.vbo);
    const loc = this.geoProg.attr('a_seg');
    for (const [start, count] of ranges) {
      if (count <= 0) continue;
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 16, start * 16);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    }
    gl.bindVertexArray(null);
  }

  drawDyn(b: DynBatch, xf: Xform, lift = 0) {
    if (!b.n) return;
    const gl = this.gl;
    gl.useProgram(this.dynProg.p);
    this.setXform(this.dynProg, xf, lift);
    gl.bindVertexArray(this.dynVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynVbo);
    gl.bufferData(gl.ARRAY_BUFFER, b.data.subarray(0, b.n * 16), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, b.n);
    gl.bindVertexArray(null);
  }

  private pass(p: Program, dst: Target | null, setup: () => void) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
    gl.viewport(0, 0, dst ? dst.w : this.w, dst ? dst.h : this.h);
    gl.useProgram(p.p);
    setup();
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bindTex(p: Program, name: string, unit: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.loc(name), unit);
  }

  endFrame(fx: FxSettings) {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    // bloom pyramid
    this.pass(this.copy, this.half, () => this.bindTex(this.copy, 'u_tex', 0, this.scene.tex));
    this.pass(this.copy, this.q1, () => this.bindTex(this.copy, 'u_tex', 0, this.half.tex));
    const blur = (a: Target, b: Target, r: number) => {
      this.pass(this.blur, b, () => { this.bindTex(this.blur, 'u_tex', 0, a.tex); gl.uniform2f(this.blur.loc('u_dir'), r / a.w, 0); });
      this.pass(this.blur, a, () => { this.bindTex(this.blur, 'u_tex', 0, b.tex); gl.uniform2f(this.blur.loc('u_dir'), 0, r / a.h); });
    };
    blur(this.q1, this.q2, 1);
    blur(this.q1, this.q2, 2);
    this.pass(this.copy, this.e1, () => this.bindTex(this.copy, 'u_tex', 0, this.q1.tex));
    blur(this.e1, this.e2, 1.5);
    blur(this.e1, this.e2, 3);
    // compose + phosphor persistence
    const prev = this.accum[this.cur];
    const next = this.accum[1 - this.cur];
    this.pass(this.compose, next, () => {
      this.bindTex(this.compose, 'u_scene', 0, this.scene.tex);
      this.bindTex(this.compose, 'u_b1', 1, this.q1.tex);
      this.bindTex(this.compose, 'u_b2', 2, this.e1.tex);
      this.bindTex(this.compose, 'u_prev', 3, prev.tex);
      gl.uniform1f(this.compose.loc('u_bloom'), fx.bloom);
      gl.uniform1f(this.compose.loc('u_decay'), fx.persistence);
    });
    this.cur = 1 - this.cur;
    this.pass(this.final, null, () => {
      this.bindTex(this.final, 'u_tex', 0, next.tex);
      gl.uniform1f(this.final.loc('u_scan'), fx.scanlines);
      gl.uniform1f(this.final.loc('u_exposure'), fx.exposure);
      gl.uniform2f(this.final.loc('u_res'), this.w, this.h);
    });
  }
}
