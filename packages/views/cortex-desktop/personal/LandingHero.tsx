// 落地页 Hero 区：生物荧光水母（SVG,自带漂浮/光晕/触手摆动动画）+ 按时段问候标题 +
// 副标题。纯展示组件,不接数据。水母为 Cortex 视觉化身,见 ./Jellyfish。
import { Jellyfish } from "./Jellyfish";

// 按当前时段返回问候语（与标题拼成「{问候}，开始你的智能体节奏」）。
function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "夜深了";
  if (h < 9) return "早上好";
  if (h < 12) return "上午好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

export function LandingHero() {
  return (
    <section className="pw-hero">
      <Jellyfish className="pw-hero-jelly" />
      <h1 className="pw-hero-title">{greeting()}，开始你的智能体节奏</h1>
      <p className="pw-hero-sub">输入一句话，或从下面继续未完成的工作。</p>
    </section>
  );
}
