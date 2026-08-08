// 语音球渲染器 —— orb-ui CloudTheme 的 WebGL 移植(纯绘制无 React 依赖)。
// 上游: https://github.com/alexanderqchen/orb-ui (src/themes/cloud/CloudTheme.tsx)
//
// 视觉构成分两层 canvas:
// - orb 层(WebGL): fbm 噪声云雾球体 —— fragment shader 内域翘曲(domain warp)+ 卷曲流场
//   合成"大气感"长英花色(periwinkle)云层,u_activity 调制翘曲幅度与云量,u_time 由
//   各状态的流速积分而来(speaking 最快、listening 次之、idle 缓慢)。
// - fx 层(2D): 环境光晕 + 截屏扫描脉冲(3 圈扩散,业务功能,上游没有)。
// 电平语义沿用旧版: listening 用实测麦克风电平,speaking 由内部正弦合成(真电平需给
// TTS <audio> 挂 AnalyserNode,列为后续增强),其余态回落 0。电平驱动两件事——
// 球体缩放(listening 收缩 / speaking 放大,CloudTheme 的"反向听觉缩放")与云层活跃度。

/** 渲染器只认四个视觉状态;transcribing 由调用方映射成 thinking。 */
export type OrbPhase = "idle" | "listening" | "thinking" | "speaking";

export interface OrbFrameInput {
  phase: OrbPhase;
  /** 0..1 目标电平(listening 时为实测;其余态忽略)。内部做阻尼平滑。 */
  targetLevel: number;
  /** 扫描脉冲开始时刻(performance.now() 时间基准);null = 无脉冲。 */
  scanAt: number | null;
}

export interface OrbRenderer {
  /** 画一帧。t 用 performance.now()/rAF 时间戳。 */
  draw(t: number, input: OrbFrameInput): void;
  /** 释放 GL 资源(组件卸载时调用;fx 2D 层无需释放)。 */
  destroy(): void;
}

// 环境光晕用色(与 shader 内 periwinkle 族一致);idle 更灰。
const ACCENT = "#8b93f8";
const IDLE_COL = "#8a94dd";
const TAU = Math.PI * 2;
// CloudTheme 的听觉缩放系数:listening 收缩 / speaking 放大。
const LISTEN_SHRINK = 0.204;
const SPEAK_GROW = 0.2145;

const VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// 逐字移植 CloudTheme 的云雾 shader(hash→值噪声→5 octave fbm→域翘曲+卷曲流场→
// 地平线分层上色);唯一改动是补一个 u_dim,idle 态整体压暗降饱和,保留可点击的存在感。
const FRAGMENT_SHADER = `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_activity;
uniform float u_dim;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.52;
  mat2 rotation = mat2(0.80, 0.60, -0.60, 0.80);
  for (int octave = 0; octave < 5; octave++) {
    value += amplitude * noise(p);
    p = rotation * p * 1.92 + vec2(9.7, 4.3);
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 centered = uv - 0.5;
  float radius = length(centered);
  float edge = 1.0 - smoothstep(0.488, 0.5, radius);
  if (edge <= 0.0) discard;

  vec2 p = centered * 2.0;
  float t = u_time;
  vec2 warp = vec2(
    fbm(p * 1.02 + vec2(t * 0.34, -t * 0.24)),
    fbm(p * 1.08 + vec2(-t * 0.27, t * 0.32) + vec2(6.7, 2.9))
  );
  vec2 curl = vec2(
    sin(p.y * 2.4 + t * 0.68 + warp.y * 3.2),
    cos(p.x * 2.1 - t * 0.61 + warp.x * 3.0)
  );
  vec2 warped =
    p +
    (warp - 0.5) * (1.18 + u_activity * 0.38) +
    curl * (0.035 + u_activity * 0.07);
  float broad = fbm(warped * 0.92 + vec2(t * 0.14, -t * 0.18));
  float folded = fbm(warped * 1.66 + vec2(-t * 0.23, t * 0.19) + 5.2);
  float field = mix(broad, folded, 0.3 + u_activity * 0.14);

  float horizon =
    0.46 +
    0.08 * sin((uv.x + warp.x * 0.2) * 5.4 + t * 0.42) +
    0.16 * (broad - 0.5);
  float upper = smoothstep(horizon - 0.12, horizon + 0.08, uv.y);
  float band = exp(-pow((uv.y - horizon) * (5.2 + u_activity * 0.8), 2.0));
  float cloud = smoothstep(0.24, 0.79, field);

  vec3 deepPeriwinkle = vec3(0.36, 0.39, 0.985);
  vec3 upperPeriwinkle = vec3(0.48, 0.56, 0.985);
  vec3 lowerLavender = vec3(0.72, 0.78, 0.975);
  vec3 milk = vec3(0.89, 0.92, 0.995);

  vec3 color = mix(lowerLavender, upperPeriwinkle, upper);
  float upperDepth = upper * (0.14 + smoothstep(0.42, 0.78, folded) * 0.5);
  color = mix(color, deepPeriwinkle, upperDepth);

  float milkAmount = clamp(band * (0.42 + cloud * 0.62), 0.0, 0.88);
  color = mix(color, milk, milkAmount);

  float lowerMist = (1.0 - upper) * smoothstep(0.58, 0.9, broad) * 0.18;
  color = mix(color, milk, lowerMist);

  // idle 压暗:向灰蓝靠拢并整体降亮,保持"待机"的安静感。
  vec3 idleColor = mix(color, vec3(dot(color, vec3(0.299, 0.587, 0.114))), 0.35) * 0.82;
  color = mix(color, idleColor, u_dim);

  float grain = (noise(gl_FragCoord.xy * 0.64) - 0.5) / 255.0;
  color += grain;

  // 上下文以 premultipliedAlpha:true 创建,输出必须预乘 alpha:边缘半透明像素若不预乘,
  // 合成时会泛出一圈亮白描边(近白的 milk 色在球底尤其明显)。
  gl_FragColor = vec4(color * edge, edge);
}
`;

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 指数阻尼插值(帧率无关,CloudTheme 同款)。 */
function damp(current: number, target: number, rate: number, deltaSeconds: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * deltaSeconds));
}

interface GlHandles {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  vertexShader: WebGLShader;
  fragmentShader: WebGLShader;
  timeLocation: WebGLUniformLocation;
  activityLocation: WebGLUniformLocation;
  dimLocation: WebGLUniformLocation;
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** 初始化 WebGL 管线;任何一步失败返回 null(调用方降级 CSS 渐变)。 */
function initGl(canvas: HTMLCanvasElement): GlHandles | null {
  const gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: true });
  if (!gl) return null;
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertexShader || !fragmentShader) return null;
  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  if (!program || !buffer) return null;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;

  const positionLocation = gl.getAttribLocation(program, "a_position");
  const resolutionLocation = gl.getUniformLocation(program, "u_resolution");
  const timeLocation = gl.getUniformLocation(program, "u_time");
  const activityLocation = gl.getUniformLocation(program, "u_activity");
  const dimLocation = gl.getUniformLocation(program, "u_dim");
  if (positionLocation < 0 || !resolutionLocation || !timeLocation || !activityLocation || !dimLocation) return null;

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelSize = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
  canvas.width = pixelSize;
  canvas.height = pixelSize;
  gl.viewport(0, 0, pixelSize, pixelSize);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
  gl.uniform2f(resolutionLocation, pixelSize, pixelSize);
  return { gl, program, buffer, vertexShader, fragmentShader, timeLocation, activityLocation, dimLocation };
}

/**
 * 创建语音球渲染器。
 * @param orbCanvas WebGL 云雾球体层(正方形,CSS 尺寸即球直径;缩放经 style.transform)
 * @param fxCanvas  2D 特效层(光晕/扫描脉冲;尺寸为整个 overlay 可视区,叠在球体下层)
 */
export function createOrbRenderer(orbCanvas: HTMLCanvasElement, fxCanvas: HTMLCanvasElement): OrbRenderer {
  const handles = initGl(orbCanvas);
  if (!handles) {
    // WebGL 不可用(极旧 GPU/驱动黑名单):退化为静态 CSS 渐变球,保留可点击的存在感。
    orbCanvas.style.background = "linear-gradient(180deg, #626afb 2%, #8f9dfb 32%, #dde6fd 52%, #c9d3fb 84%)";
    orbCanvas.style.borderRadius = "50%";
  }

  // 帧间状态(全部阻尼平滑,帧率无关)。
  let level = 0;
  let audioScale = 1;
  let activity = 0.1;
  let dim = 1;
  let flowTime = 0;
  let prevT: number | null = null;

  function draw(t: number, input: OrbFrameInput): void {
    const deltaSeconds = prevT === null ? 0.016 : Math.min((t - prevT) / 1000, 0.05);
    prevT = t;
    const v = input.phase;

    // 电平:listening 追实测(涨快落慢,CloudTheme 同款不对称阻尼),speaking 合成振荡。
    let target = 0;
    if (v === "listening") target = clamp01(input.targetLevel);
    if (v === "speaking") target = 0.3 + 0.55 * Math.abs(Math.sin(t / 340) * Math.sin(t / 730));
    level = damp(level, target, target > level ? 11 : 6, deltaSeconds);

    // 听觉缩放:listening 收缩(把注意力"吸"向用户)、speaking 放大(球在"发声")。
    let scaleTarget = 1;
    if (v === "listening") scaleTarget = 1 - level * LISTEN_SHRINK;
    if (v === "speaking") scaleTarget = 1 + level * SPEAK_GROW;
    const scaleRate = Math.abs(scaleTarget - 1) > Math.abs(audioScale - 1) ? 12 : 6;
    audioScale = damp(audioScale, scaleTarget, scaleRate, deltaSeconds);
    orbCanvas.style.transform = `scale(${audioScale})`;

    // 各状态的云层流速/活跃度(listening/speaking 取自上游;thinking 取中间值示"在忙")。
    let speed = 0.24;
    let activityTarget = 0.1;
    if (v === "listening") {
      speed = 0.72 + level * 0.78;
      activityTarget = 0.28 + level * 0.32;
    } else if (v === "speaking") {
      speed = 1.65 + level * 1.55;
      activityTarget = 0.66 + level * 0.34;
    } else if (v === "thinking") {
      speed = 0.55;
      activityTarget = 0.22;
    }
    activity = damp(activity, activityTarget, 6, deltaSeconds);
    dim = damp(dim, v === "idle" ? 1 : 0, 8, deltaSeconds);
    flowTime += deltaSeconds * speed;

    if (handles && !handles.gl.isContextLost()) {
      const { gl } = handles;
      gl.uniform1f(handles.timeLocation, flowTime);
      gl.uniform1f(handles.activityLocation, activity);
      gl.uniform1f(handles.dimLocation, dim);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    drawFx(t, input);
  }

  /** fx 层:环境光晕(常驻)+ 截屏扫描脉冲(3 圈相位错开,1300ms 播完)。 */
  function drawFx(t: number, input: OrbFrameInput): void {
    const dpr = window.devicePixelRatio || 1;
    const W = fxCanvas.clientWidth;
    const H = fxCanvas.clientHeight;
    if (!W || !H) return;
    if (fxCanvas.width !== W * dpr) {
      fxCanvas.width = W * dpr;
      fxCanvas.height = H * dpr;
    }
    const ctx = fxCanvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2;
    const r = (orbCanvas.clientWidth / 2) * audioScale;
    const col = input.phase === "idle" ? IDLE_COL : ACCENT;

    const g = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, Math.min(W, H) / 2);
    g.addColorStop(0, rgba(col, input.phase === "idle" ? 0.1 : 0.2 + level * 0.08));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    if (input.scanAt !== null && t - input.scanAt < 1300) {
      const p = (t - input.scanAt) / 1300;
      for (let i = 0; i < 3; i += 1) {
        const pp = Math.max(0, p - i * 0.12);
        if (pp <= 0) continue;
        ctx.beginPath();
        ctx.arc(cx, cy, r + pp * r * 1.8, 0, TAU);
        ctx.strokeStyle = rgba(ACCENT, 0.5 * (1 - pp));
        ctx.lineWidth = 2 - pp;
        ctx.stroke();
      }
    }
  }

  return {
    draw,
    destroy(): void {
      if (!handles) return;
      const { gl } = handles;
      gl.deleteProgram(handles.program);
      gl.deleteBuffer(handles.buffer);
      gl.deleteShader(handles.vertexShader);
      gl.deleteShader(handles.fragmentShader);
    },
  };
}
