// 落地页 Hero 区：生物荧光水母（SVG,自带漂浮/光晕/触手摆动动画）+ 激励问候语。
// 文案优先用「每日 LLM 增强」(useDailyEncouragement,基于默认 agent 按天生成并缓存);
// 无 LLM 文案(web/未配默认 agent/生成中/失败)时回退静态精选池(pickEncouragement)。
// 停留在落地页时每 30 分钟自动调用默认 agent 刷新文案,用 fade 动画切换。
// 水母为 Cortex 视觉化身,见 ./Jellyfish。
// tabs:可选的场景 tab 槽位(日常办公/设计创意,由 SceneChips 经 render prop 注入),
// 渲染在副标题下方,与标题/副标题同一条左缘。
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  buildEncouragePrompt,
  completeWithDefaultAgent,
  parseEncouragement,
  useDesktopBridge,
  useDailyEncouragement,
  usePersonalStore,
} from "@cortex-work/core";
import { Jellyfish } from "./Jellyfish";
import { pickEncouragement } from "./encouragements";

const ROTATE_MS = 30 * 60 * 1000; // 30 分钟轮换一次
const FADE_MS = 500;               // 淡出/淡入各 500ms

export function LandingHero({ tabs }: { tabs?: ReactNode }) {
  const bridge = useDesktopBridge();
  const daily = useDailyEncouragement();
  // 仅对已配置默认 agent 的用户启用定时轮换（与 useDailyEncouragement 的 opt-in 策略一致）
  const optedIn = usePersonalStore((s) => !!s.generalSettings.defaultAgent);

  const [current, setCurrent] = useState(() => daily ?? pickEncouragement(new Date()));
  const [visible, setVisible] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  // daily 首次异步到达时同步到展示状态
  useEffect(() => {
    if (daily) setCurrent(daily);
  }, [daily]);

  const rotate = useCallback(async () => {
    if (!bridge) return;
    try {
      const text = await completeWithDefaultAgent(bridge, buildEncouragePrompt(new Date()));
      const parsed = parseEncouragement(text);
      if (!parsed || !mountedRef.current) return;

      // 淡出 → 换内容 → 淡入
      setVisible(false);
      await new Promise<void>((r) => setTimeout(r, FADE_MS));
      if (!mountedRef.current) return;
      setCurrent(parsed);
      setVisible(true);
    } catch {
      // 生成失败静默保持当前文案
    }
  }, [bridge]);

  useEffect(() => {
    if (!bridge || !optedIn) return;
    const id = setInterval(rotate, ROTATE_MS);
    return () => clearInterval(id);
  }, [bridge, optedIn, rotate]);

  return (
    <section className="pw-hero">
      <Jellyfish className="pw-hero-jelly" />
      <div className={`pw-hero-content${visible ? "" : " pw-hero-content--out"}`}>
        <h1 className="pw-hero-title">{current.title}</h1>
        <p className="pw-hero-sub">{current.sub}</p>
        {tabs}
      </div>
    </section>
  );
}
