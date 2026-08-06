// 语音球 canvas 逐帧渲染器(设计稿 Cortex Voice HiFi 的忠实移植,纯绘制无 React 依赖)。
//
// 视觉构成(自外向内):环境光晕 → 聆听涟漪 → 两圈虚线环 → 思考轨道粒子 → 球体
// (恒定尺寸线性渐变 + 随电平的辉光)→ 球内 clip 的 9 条白色云雾 wisp(唯一签名效果,
// 状态只调制它的速度/起伏/密度,thinking 时整团缓旋)→ 截屏扫描脉冲(3 圈扩散)。
// 电平语义:listening 用真实麦克风电平(外部传入),speaking 由内部正弦合成
// (真电平要给 TTS <audio> 挂 AnalyserNode,列为后续增强),其余态回落 0。

/** 渲染器只认四个视觉状态;transcribing 由调用方映射成 thinking。 */
export type OrbPhase = "idle" | "listening" | "thinking" | "speaking";

export interface OrbFrameInput {
  phase: OrbPhase;
  /** 0..1 目标电平(listening 时为实测;其余态忽略)。内部做 lerp 平滑。 */
  targetLevel: number;
  /** 扫描脉冲开始时刻(performance.now() 时间基准);null = 无脉冲。 */
  scanAt: number | null;
}

// 设计稿默认 accent(紫蓝);idle 用更灰的同族色。
const ACCENT = "#8b93f8";
const IDLE_COL = "#8a94dd";
const TAU = Math.PI * 2;

interface Wisp {
  x: number;
  y: number;
  len: number;
  th: number;
  rot: number;
  a: number;
  spd: number;
  ph: number;
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export interface OrbRenderer {
  /** 画一帧。t 用 performance.now()/rAF 时间戳。 */
  draw(t: number, input: OrbFrameInput): void;
}

export function createOrbRenderer(canvas: HTMLCanvasElement): OrbRenderer {
  let level = 0;
  let ripples: { r: number; a: number }[] = [];
  let rippleCd = 0;
  // 云雾带:斜向漂移的白色椭圆雾团,初始化一次、循环回卷。
  const wisps: Wisp[] = [];
  for (let i = 0; i < 9; i += 1) {
    wisps.push({
      x: Math.random() * 2.8 - 1.4,
      y: (Math.random() - 0.5) * 0.7 + ((i % 3) - 1) * 0.18,
      len: 0.5 + Math.random() * 0.6,
      th: 0.1 + Math.random() * 0.16,
      rot: -0.28 + Math.random() * 0.2,
      a: 0.18 + Math.random() * 0.3,
      spd: 0.5 + Math.random() * 0.9,
      ph: Math.random() * 6.3,
    });
  }

  function draw(t: number, input: OrbFrameInput): void {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== W * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const v = input.phase;
    const cx = W / 2;
    const cy = H / 2;
    const col = v === "idle" ? IDLE_COL : ACCENT;
    const base = Math.min(W, H) * 0.34;
    const r = base * 0.95; // 球体尺寸恒定 —— 只有内部效果对电平起反应
    const ringMul = [1.14, 1.28];

    // 电平平滑:listening 追实测,speaking 合成振荡,其余回落 0。
    let target = 0;
    if (v === "listening") target = Math.max(0, Math.min(1, input.targetLevel));
    if (v === "speaking") target = 0.3 + 0.55 * Math.abs(Math.sin(t / 340) * Math.sin(t / 730));
    level += (target - level) * 0.045;

    // 环境光晕
    let g: CanvasGradient = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r * 4);
    g.addColorStop(0, rgba(col, v === "idle" ? 0.1 : 0.22));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 聆听涟漪:响度越过阈值时向外发圈
    if (v === "listening") {
      rippleCd -= 1;
      if (level > 0.62 && rippleCd <= 0) {
        ripples.push({ r: r * 1.1, a: 0.4 });
        rippleCd = 22;
      }
    }
    ripples = ripples.filter((p) => p.a > 0.02);
    for (const p of ripples) {
      p.r += 1.8;
      p.a *= 0.965;
      ctx.beginPath();
      ctx.arc(cx, cy, p.r, 0, TAU);
      ctx.strokeStyle = rgba(col, p.a);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // 两圈虚线环:thinking 快转,其余慢转;listening 半径随电平微涨
    const spin = v === "thinking" ? t / 900 : t / 6000;
    for (let i = 0; i < 2; i += 1) {
      const rr = r * (ringMul[i] ?? 1) + (v === "listening" ? level * 3 : 0);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(spin * (i ? -1 : 1));
      ctx.beginPath();
      ctx.setLineDash([3, 7]);
      ctx.arc(0, 0, rr, 0, TAU);
      ctx.strokeStyle = rgba(col, v === "idle" ? 0.12 : 0.28 - i * 0.1);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
    ctx.setLineDash([]);

    // 思考轨道粒子(压扁的椭圆轨道)
    if (v === "thinking") {
      for (let i = 0; i < 10; i += 1) {
        const a = t / 500 + i * 0.628;
        const rr = r * 1.22 + Math.sin(t / 300 + i) * 3;
        const px = cx + Math.cos(a) * rr;
        const py = cy + Math.sin(a) * rr * 0.45;
        ctx.beginPath();
        ctx.arc(px, py, 2.2, 0, TAU);
        ctx.fillStyle = rgba(ACCENT, 0.4 + 0.4 * Math.abs(Math.sin(t / 700 + i)));
        ctx.fill();
      }
    }

    // 球体:上下线性渐变 + 随电平的辉光
    g = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
    if (v === "idle") {
      g.addColorStop(0, "#8089d8");
      g.addColorStop(0.5, "#98a2e8");
      g.addColorStop(1, "#c0cbf5");
    } else {
      g.addColorStop(0, "#6d7bf2");
      g.addColorStop(0.5, "#8f9cf8");
      g.addColorStop(1, "#c9d6fd");
    }
    ctx.save();
    ctx.shadowColor = col;
    ctx.shadowBlur = v === "idle" ? 12 : 30 + level * 12;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();

    // ── 球内效果(clip 在恒定尺寸的球里) ──
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.clip();
    const drift = v === "idle" ? 0.35 : v === "thinking" ? 0.6 : 0.8 + level * 2.0;
    const bob = r * (0.015 + level * (v === "idle" ? 0.015 : 0.14));
    const swirl = v === "thinking" ? t / 9000 : 0;
    for (const wsp of wisps) {
      wsp.x += 0.00011 * wsp.spd * drift;
      if (wsp.x > 1.4) wsp.x = -1.4;
      const edge = Math.min(1, (1.4 - Math.abs(wsp.x)) / 0.3);
      if (edge <= 0) continue;
      let wx = wsp.x;
      let wy2 = wsp.y + wsp.x * -0.22; // 斜向雾带
      if (swirl) {
        const ca = Math.cos(swirl);
        const sa = Math.sin(swirl);
        const nx = wx * ca - wy2 * sa;
        const ny = wx * sa + wy2 * ca;
        wx = nx;
        wy2 = ny;
      }
      const px = cx + wx * r;
      const py = cy + wy2 * r + Math.sin(t / 2400 + wsp.ph) * bob + Math.sin(t / 1050 + wsp.ph * 2) * bob * 0.4;
      const L = wsp.len * r;
      const T = wsp.th * r * (1 + 0.1 * Math.sin(t / 3300 + wsp.ph));
      const a = wsp.a * edge * (v === "idle" ? 0.8 : 0.9 + level * 0.5);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(wsp.rot);
      const wg = ctx.createRadialGradient(0, 0, 0, 0, 0, L);
      wg.addColorStop(0, `rgba(255,255,255,${Math.min(0.85, a)})`);
      wg.addColorStop(0.5, `rgba(255,255,255,${a * 0.4})`);
      wg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = wg;
      ctx.beginPath();
      ctx.ellipse(0, 0, L, T, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    // 截屏扫描脉冲:3 圈相位错开的扩散圆环,1300ms 内播完
    if (input.scanAt !== null && t - input.scanAt < 1300) {
      const p = (t - input.scanAt) / 1300;
      for (let i = 0; i < 3; i += 1) {
        const pp = Math.max(0, p - i * 0.12);
        if (pp <= 0) continue;
        ctx.beginPath();
        ctx.arc(cx, cy, r + pp * r * 2.6, 0, TAU);
        ctx.strokeStyle = rgba(ACCENT, 0.5 * (1 - pp));
        ctx.lineWidth = 2 - pp;
        ctx.stroke();
      }
    }
  }

  return { draw };
}
