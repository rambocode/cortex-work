/* =========================================================================
   Automation · 无人值守区块（定时自动化 × 用量与节奏）
   server 组件：纯展示，无 hooks / 无客户端能力。文案全部取自 d.automation。
   左栏「定时自动化」要点列表（荧光勾）；右栏一张 mock 用量卡：
   7×5 发光强度小格日历（强度由 index 派生，确定性、无随机）+ 两个统计。
   一抹 aurora 作氛围。视觉论点：clay 橙=动作、glow 蓝紫=智能氛围，克制不堆渐变。
   配套 scoped CSS 见 globals.css 末尾「Automation 区块」段。
   ========================================================================= */

import { IconCheck } from "@/components/icons";
import { Reveal } from "@/components/ui";
import type { Dict } from "@/lib/dictionary";
import type { Locale } from "@/lib/i18n";

// 日历格子总数：7 列 × 5 行。
const COLS = 7;
const ROWS = 5;
const CELLS = COLS * ROWS;

/**
 * 由格子序号派生 0..1 的「发光强度」。
 * 纯确定性算法（避免随机数导致 SSR / CSR hydration 不一致）：
 * 取 (index * 37) % 100 落到 [0,1)，再做轻微 gamma 让低强度更稀疏、高光更突出。
 */
function cellIntensity(index: number): number {
  const raw = ((index * 37) % 100) / 100; // 0..0.99，分布均匀且确定
  return raw * raw * (0.55 + 0.45 * raw); // 偏向低强度、点缀少量高光
}

export default function Automation({ d }: { d: Dict; locale: Locale }) {
  const a = d.automation;

  return (
    <section className="section auto-sec" aria-labelledby="auto-title">
      {/* 一抹蓝紫极光作氛围（z-index:0，置于内容之下） */}
      <span className="aurora" aria-hidden />

      <div className="container content">
        {/* 标题区 */}
        <Reveal className="auto-head">
          <span className="eyebrow">{a.eyebrow}</span>
          <h2 className="h2" id="auto-title" style={{ textWrap: "balance" } as React.CSSProperties}>
            {a.title}
          </h2>
        </Reveal>

        {/* 两列：左定时自动化 / 右用量与节奏 */}
        <div className="grid grid-2 auto-grid">
          {/* —— 左：定时自动化 —— */}
          <Reveal className="auto-col" i={1}>
            <h3 className="h3">{a.auto.title}</h3>
            <p className="muted auto-desc">{a.auto.desc}</p>
            <ul className="auto-bullets">
              {a.auto.bullets.map((b) => (
                <li key={b}>
                  <span className="auto-check" aria-hidden>
                    <IconCheck />
                  </span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </Reveal>

          {/* —— 右：用量与节奏 mock 卡 —— */}
          <Reveal className="auto-col" i={2}>
            {/* 卡片本身是一个完整的展示单元（带柔光 hover），故用 card */}
            <div className="card card--pad card--hover auto-usage">
              <div className="auto-usage-head">
                <h3 className="h3">{a.usage.title}</h3>
                <p className="muted auto-usage-desc">{a.usage.desc}</p>
              </div>

              {/* 7×5 发光强度小格日历（35 个小方块，强度由 index 派生） */}
              <div className="auto-cal" role="img" aria-label={a.usage.title}>
                {Array.from({ length: CELLS }, (_, i) => {
                  const t = cellIntensity(i);
                  // 低强度偏蓝（智能氛围），高强度向暖陶土过渡（活跃峰值）
                  const color = t > 0.62 ? "var(--clay)" : "var(--glow-blue)";
                  // 不透明度落在可见区间，强度越高越亮
                  const opacity = 0.1 + t * 0.85;
                  return (
                    <span
                      key={i}
                      className="auto-cell"
                      style={{ background: color, opacity }}
                      aria-hidden
                    />
                  );
                })}
              </div>

              {/* 两个统计 */}
              <div className="auto-stats">
                <div className="auto-stat">
                  <span className="auto-stat-value mono">{a.usage.stat1.value}</span>
                  <span className="auto-stat-label muted">{a.usage.stat1.label}</span>
                </div>
                <div className="auto-stat">
                  <span className="auto-stat-value mono">{a.usage.stat2.value}</span>
                  <span className="auto-stat-label muted">{a.usage.stat2.label}</span>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
