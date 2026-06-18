/* =========================================================================
   AccountingShowcase · 会计录入(拖入的自定义 skill 示例,id="accounting")
   server 组件。两列:左文案、右演示 mock(与 SkillShowcase 左右相反,制造节奏)。
   叙事:同一个输入框,拖进「会计录入」skill,大白话记一笔 → Agent 拆成结构化条目。
   mock:
     - composer:顶部 SK 引用 pill(skill 名)+ placeholder + 「记一笔」按钮
     - 向下「拆分」提示 → 结构化账本:表头 cols + rows 级联淡入 + 「已记账」徽标
   颜色/圆角全部走 globals.css token;可见文案来自 d.accounting(含 mock 标签)。
   mock 整体 aria-hidden(纯演示),语义由左侧文案承载。
   动画:rows 级联入场用 .reveal.is-visible 门控(滚动进入视口才播),
        reduced-motion 下直显终态。
   ========================================================================= */

import { IconCheck } from "@/components/icons";
import type { Dict } from "@/lib/dictionary";
import type { Locale } from "@/lib/i18n";

export default function AccountingShowcase({ d }: { d: Dict; locale: Locale }) {
  const a = d.accounting;
  const m = a.mock;

  return (
    <section id="accounting" className="section">
      <div className="container acc-grid">
        {/* ——— 左:文案 ——— */}
        <div className="acc-copy">
          <p className="eyebrow">{a.eyebrow}</p>
          <h2 className="h2 acc-copy__title">{a.title}</h2>
          <p className="lead acc-copy__sub">{a.sub}</p>
          <ul className="acc-points">
            {a.points.map((point, i) => (
              <li key={i} className="acc-point">
                <span className="acc-point__check" aria-hidden="true">
                  <IconCheck />
                </span>
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* ——— 右:composer → 结构化账本 mock ——— */}
        <div className="acc-visual" aria-hidden="true">
          <span className="halo acc-halo" />

          <div className="card acc-stage">
            {/* composer:拖入的会计 skill + 大白话一句 */}
            <div className="acc-composer">
              <div className="acc-attach">
                <span className="acc-badge">SK</span>
                <span className="acc-attach__name mono">{m.skill}</span>
                <span className="acc-attach__x">×</span>
              </div>
              <p className="acc-composer__ph">
                {m.placeholder}
                <span className="acc-caret" />
              </p>
              <div className="acc-composer__bar">
                <span className="acc-send">{m.send}</span>
              </div>
            </div>

            {/* 拆分提示 */}
            <span className="acc-split">{m.skill} → {m.cols.join(" · ")}</span>

            {/* 结构化账本:表头 + 级联行 + 已记账徽标 */}
            <div className="acc-ledger">
              <div className="acc-ledger__head">
                {m.cols.map((c) => (
                  <span key={c} className="acc-col">{c}</span>
                ))}
              </div>
              {m.rows.map((r, i) => (
                <div key={i} className="acc-row" style={{ ["--r" as any]: i }}>
                  <span className="acc-cell mono">{r.date}</span>
                  <span className="acc-cell acc-cell--cat">{r.cat}</span>
                  <span className="acc-cell mono acc-cell--amt">{r.amount}</span>
                  <span className="acc-cell mono acc-cell--acct">{r.account}</span>
                </div>
              ))}
              <div className="acc-done">
                <span className="acc-done__badge">
                  <IconCheck />
                  {m.done}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .acc-grid {
          display: grid;
          grid-template-columns: 0.98fr 1.02fr;
          gap: clamp(28px, 4vw, 60px);
          align-items: center;
        }

        /* —— 左侧文案 —— */
        .acc-copy__title { margin-top: 14px; text-wrap: balance; }
        .acc-copy__sub { margin-top: 14px; max-width: 46ch; }
        .acc-points { list-style: none; margin: 24px 0 0; padding: 0; display: flex; flex-direction: column; gap: 15px; }
        .acc-point { display: flex; align-items: flex-start; gap: 12px; color: var(--ink); }
        .acc-point__check {
          flex: none;
          display: inline-flex; align-items: center; justify-content: center;
          width: 26px; height: 26px; margin-top: 1px;
          border-radius: 50%;
          color: var(--glow-blue);
          background: linear-gradient(var(--paper-raise), var(--paper-raise)) padding-box,
            var(--grad-jelly) border-box;
          border: 1px solid transparent;
        }
        .acc-point__check svg { width: 15px; height: 15px; }

        /* —— 右侧 mock —— */
        .acc-visual { position: relative; min-width: 0; }
        .acc-halo { width: 66%; height: 64%; top: -4%; right: 6%; z-index: 0; }
        .acc-stage {
          position: relative; z-index: 1;
          padding: clamp(16px, 2vw, 22px);
          display: flex; flex-direction: column; gap: 12px;
          background: var(--paper-sink);
        }

        /* SK 徽标 */
        .acc-badge {
          flex: none;
          display: inline-flex; align-items: center; justify-content: center;
          width: 22px; height: 18px; border-radius: 5px;
          background: var(--clay); color: #fff;
          font-size: 0.6rem; font-weight: 700; letter-spacing: 0.04em;
          font-family: var(--font-sans);
        }

        /* composer */
        .acc-composer {
          background: var(--paper-raise);
          border: 1px solid var(--line-strong);
          border-radius: var(--r);
          box-shadow: var(--shadow-raise);
          padding: 11px 12px 10px;
        }
        .acc-attach {
          display: inline-flex; align-items: center; gap: 7px;
          background: var(--paper-sink);
          border: 1px solid var(--line);
          border-radius: var(--r-pill);
          padding: 3px 9px 3px 4px; margin-bottom: 9px;
        }
        .acc-attach__name { font-size: 0.74rem; color: var(--ink); }
        .acc-attach__x { color: var(--ink-3); font-size: 0.9rem; line-height: 1; }
        .acc-composer__ph {
          color: var(--ink-2); font-size: var(--fs-sm);
          margin: 2px 2px 12px;
          display: flex; align-items: center;
        }
        /* 输入光标:闪烁 */
        .acc-caret {
          display: inline-block; width: 1.5px; height: 1.05em;
          margin-left: 2px; background: var(--clay);
          animation: accCaret 1.1s steps(1) infinite;
        }
        .acc-composer__bar {
          display: flex; align-items: center; justify-content: flex-end;
          padding-top: 9px; border-top: 1px solid var(--line-soft);
        }
        .acc-send {
          font-size: 0.78rem; font-weight: 600; color: #fff;
          background: var(--clay);
          border-radius: var(--r-pill); padding: 6px 15px;
          box-shadow: 0 1px 2px rgba(20, 18, 12, 0.18), 0 8px 18px -10px rgba(201, 100, 66, 0.6);
        }

        /* 拆分提示 */
        .acc-split {
          align-self: center;
          font-family: var(--font-mono);
          font-size: 0.7rem; color: var(--ink-3);
          position: relative; padding-top: 16px;
        }
        .acc-split::before {
          content: "↓"; position: absolute; left: 50%; top: -2px;
          transform: translateX(-50%);
          color: var(--glow-blue); font-weight: 700; font-family: var(--font-sans);
        }

        /* 结构化账本 */
        .acc-ledger {
          background: var(--paper-raise);
          border: 1px solid var(--line);
          border-radius: var(--r);
          box-shadow: var(--shadow-raise);
          padding: 6px 4px 8px;
        }
        .acc-ledger__head, .acc-row {
          display: grid;
          grid-template-columns: 0.7fr 0.9fr 0.8fr 0.8fr;
          align-items: center;
          gap: 8px;
          padding: 7px 12px;
        }
        .acc-col {
          font-size: var(--fs-eyebrow); font-weight: 600;
          letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3);
        }
        .acc-row {
          border-top: 1px solid var(--line-soft);
        }
        .acc-cell { font-size: 0.8rem; color: var(--ink); }
        .acc-cell--cat { color: var(--ink-2); }
        .acc-cell--amt { color: var(--clay-deep); font-weight: 650; }
        .acc-cell--acct { color: var(--ink-3); }

        /* 已记账徽标 */
        .acc-done {
          display: flex; justify-content: flex-end;
          padding: 9px 12px 4px;
        }
        .acc-done__badge {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 0.72rem; font-weight: 600; color: var(--ok);
          background: var(--ok-soft);
          border-radius: var(--r-pill); padding: 4px 11px 4px 9px;
        }
        .acc-done__badge svg { width: 13px; height: 13px; }

        /* —— 动画:rows 级联 + 徽标脉冲,默认 paused,滚动进入视口(.is-visible)才播 —— */
        .acc-row, .acc-done__badge { opacity: 0; }
        .acc-row {
          transform: translateY(6px);
          animation: accRowIn 0.5s var(--ease-out) forwards paused;
          animation-delay: calc(0.25s + var(--r) * 0.32s);
        }
        .acc-done__badge {
          animation: accDoneIn 0.45s var(--ease-out) forwards paused;
          animation-delay: 1.1s;
        }
        .reveal.is-visible .acc-row,
        .reveal.is-visible .acc-done__badge {
          animation-play-state: running;
        }
        @keyframes accRowIn {
          to { opacity: 1; transform: none; }
        }
        @keyframes accDoneIn {
          0% { opacity: 0; transform: scale(0.9); }
          60% { opacity: 1; transform: scale(1.06); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes accCaret {
          0%, 50% { opacity: 1; }
          50.01%, 100% { opacity: 0; }
        }

        /* —— 移动端:单列,文案在上、mock 在下 —— */
        @media (max-width: 860px) {
          .acc-grid { grid-template-columns: 1fr; gap: 32px; }
        }

        /* —— reduced-motion:全部直显终态 —— */
        @media (prefers-reduced-motion: reduce) {
          .acc-caret { animation: none; opacity: 1; }
          .acc-row, .acc-done__badge {
            opacity: 1 !important; transform: none !important; animation: none !important;
          }
        }
      `}</style>
    </section>
  );
}
