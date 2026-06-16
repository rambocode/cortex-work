/* =========================================================================
   Agents 区块 · 多 Agent 生态（id="agents"）
   server 组件（无 hooks / 无 use client）：标题区 + 三张 agent 卡片 + 通道一排 pill。
   设计论点：暖纸工作台 × 蓝紫生物荧光。每个 agent 按 key 取一抹品牌氛围色，
   只用细描边 / 左上角发光小色块区分，克制不堆渐变；卡片底部放一枚字母标记。
   只用 globals.css 既有 class + 内联 style（token 变量），不新增依赖、不改他人文件。
   ========================================================================= */

import type { Dict, AgentItem } from "@/lib/dictionary";
import type { Locale } from "@/lib/i18n";

/**
 * 每个 agent 的氛围色（仅用于卡片顶部细高光 + 左上发光小色块，克制不堆渐变）：
 * - claude：陶土橙，呼应 Anthropic 的暖陶土调
 * - codex：蓝灰，沉稳工程感（不用 --ink-2，避免描边发灰发脏）
 * - pi：蓝紫荧光，最贴近品牌水母的智能氛围
 */
const AGENT_ACCENTS: Record<AgentItem["key"], { accent: string; soft: string }> = {
  claude: { accent: "var(--clay)", soft: "var(--clay-soft)" },
  codex: { accent: "var(--glow-blue)", soft: "rgba(91, 140, 255, 0.12)" },
  pi: { accent: "var(--glow-violet)", soft: "rgba(139, 92, 246, 0.12)" },
};

export default function Agents({ d }: { d: Dict; locale: Locale }) {
  const { eyebrow, title, sub, items, extra } = d.agents;

  return (
    <section id="agents" className="section">
      <div className="container">
        {/* —— 标题区：限宽居中，克制留白 —— */}
        <header
          className="container-narrow"
          style={{ paddingInline: 0, textAlign: "center", marginInline: "auto" }}
        >
          <p className="eyebrow" style={{ justifyContent: "center" }}>
            {eyebrow}
          </p>
          <h2 className="h2" style={{ marginTop: 14, textWrap: "balance" }}>
            {title}
          </h2>
          <p className="lead" style={{ marginTop: 14 }}>
            {sub}
          </p>
        </header>

        {/* —— 三张 agent 卡片（本身是可选交互单元，故用 card）—— */}
        <ul
          className="grid grid-3"
          style={{
            listStyle: "none",
            margin: "clamp(36px, 5vw, 56px) 0 0",
            padding: 0,
          }}
        >
          {items.map((item) => {
            const tone = AGENT_ACCENTS[item.key];
            return (
              <li key={item.key} style={{ display: "flex" }}>
                <article
                  className="card card--pad card--hover"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 14,
                    width: "100%",
                    // 顶部一道细的氛围色高光，呼应该 agent 的品牌色（克制：仅 1px）
                    borderTop: `2px solid ${tone.accent}`,
                  }}
                >
                  {/* 头部：左上发光小色块 + 名称 + tag 小标 */}
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    {/* 发光小色块：该 agent 的氛围点睛 */}
                    <span
                      aria-hidden="true"
                      style={{
                        flex: "0 0 auto",
                        width: 12,
                        height: 12,
                        borderRadius: 4,
                        background: tone.accent,
                        boxShadow: `0 0 0 4px ${tone.soft}`,
                      }}
                    />
                    <h3 className="h3" style={{ flex: 1, minWidth: 0 }}>
                      {item.name}
                    </h3>
                    {/* tag 用中性边，agent 色由顶部高光 + 左上发光点承载 */}
                    <span className="pill" style={{ flex: "0 0 auto" }}>
                      {item.tag}
                    </span>
                  </div>

                  {/* 描述 */}
                  <p className="muted" style={{ margin: 0, lineHeight: 1.56 }}>
                    {item.desc}
                  </p>
                </article>
              </li>
            );
          })}
        </ul>

        {/* —— 通道一行：还能接入你自己的模型通道 + 一排 pill —— */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "center",
            gap: "12px 14px",
            marginTop: "clamp(28px, 4vw, 44px)",
          }}
        >
          <span className="muted" style={{ fontWeight: 550 }}>
            {extra.title}
          </span>
          <ul
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              listStyle: "none",
              margin: 0,
              padding: 0,
            }}
          >
            {extra.providers.map((provider) => (
              <li key={provider}>
                {/* pill--glow：蓝紫渐变描边，点出「智能通道」氛围 */}
                <span className="pill pill--glow">{provider}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
