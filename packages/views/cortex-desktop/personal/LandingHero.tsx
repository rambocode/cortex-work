// 落地页 Hero 区：生物荧光水母（SVG,自带漂浮/光晕/触手摆动动画）+ 激励问候语。
// 文案优先用「每日 LLM 增强」(useDailyEncouragement,基于默认 agent 按天生成并缓存);
// 无 LLM 文案(web/未配默认 agent/生成中/失败)时回退静态精选池(pickEncouragement)。
// 水母为 Cortex 视觉化身,见 ./Jellyfish。
import { useDailyEncouragement } from "@cortex-work/core";
import { Jellyfish } from "./Jellyfish";
import { pickEncouragement } from "./encouragements";

export function LandingHero() {
  const daily = useDailyEncouragement();
  const { title, sub } = daily ?? pickEncouragement(new Date());
  return (
    <section className="pw-hero">
      <Jellyfish className="pw-hero-jelly" />
      <h1 className="pw-hero-title">{title}</h1>
      <p className="pw-hero-sub">{sub}</p>
    </section>
  );
}
