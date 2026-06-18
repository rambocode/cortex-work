/* =========================================================================
   NotesShowcase · 闪记 / Flash Notes（id="notes"）
   server 组件。两列：左文案、右演示 mock（与 SkillShowcase 左右相反，制造节奏）。
   mock 演示真实 UX：
     - 全局捕捉浮层（独立置顶小窗）：标题 + ⌘⇧N 键位、占位文字、项目切换 + 保存
     - 下方「收件箱 → 深化中 → 已深化」三段流程 + 产出文档 chip（brainstorm.md / plan.md）
   颜色走 token；可见文案来自 d.notes（含 mock 标签）。mock 整体 aria-hidden。
   ========================================================================= */

import { IconCheck } from "@/components/icons";
import type { Dict } from "@/lib/dictionary";
import type { Locale } from "@/lib/i18n";

export default function NotesShowcase({ d }: { d: Dict; locale: Locale }) {
  const n = d.notes;
  const m = n.mock;

  return (
    <section id="notes" className="section">
      <div className="container nt-grid">
        {/* ——— 左：文案 ——— */}
        <div className="nt-copy">
          <p className="eyebrow">{n.eyebrow}</p>
          <h2 className="h2 nt-copy__title">{n.title}</h2>
          <p className="lead nt-copy__sub">{n.sub}</p>
          <ul className="nt-points">
            {n.points.map((point, i) => (
              <li key={i} className="nt-point">
                <span className="nt-point__check" aria-hidden="true">
                  <IconCheck />
                </span>
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* ——— 右：捕捉浮层 + 深化流程 mock ——— */}
        <div className="nt-visual" aria-hidden="true">
          <span className="halo nt-halo" />

          {/* 全局捕捉浮层（置顶小窗） */}
          <div className="card nt-overlay glass">
            <div className="nt-overlay__head">
              <span className="dot nt-dot anim-halo" />
              <span className="nt-overlay__title">{m.title}</span>
              <span className="nt-kbd mono">{m.shortcut}</span>
            </div>
            <p className="nt-overlay__ph">{m.placeholder}<span className="nt-caret" /></p>
            <div className="nt-overlay__foot">
              <span className="pill nt-proj">
                <span className="dot" />
                <span className="mono">{m.project}</span>
              </span>
              <span className="btn btn--primary nt-save">{m.save}</span>
            </div>
          </div>

          {/* 深化状态流：收件箱 → 深化中 → 已深化 */}
          <div className="nt-flow">
            <span className="nt-stage">{m.stage1}</span>
            <span className="nt-flow__arrow">→</span>
            <span className="nt-stage nt-stage--active">{m.stage2}</span>
            <span className="nt-flow__arrow">→</span>
            <span className="nt-stage nt-stage--done">{m.stage3}</span>
          </div>

          {/* 产出文档 */}
          <div className="nt-outputs">
            <span className="nt-file mono">{m.output}</span>
            <span className="nt-file mono">{m.plan}</span>
          </div>
        </div>
      </div>

      <style>{`
        .nt-grid {
          display: grid;
          grid-template-columns: 0.98fr 1.02fr;
          gap: clamp(28px, 4vw, 60px);
          align-items: center;
        }

        /* —— 左侧文案 —— */
        .nt-copy__title { margin-top: 14px; text-wrap: balance; }
        .nt-copy__sub { margin-top: 14px; max-width: 46ch; }
        .nt-points { list-style: none; margin: 24px 0 0; padding: 0; display: flex; flex-direction: column; gap: 15px; }
        .nt-point { display: flex; align-items: flex-start; gap: 12px; color: var(--ink); }
        .nt-point__check {
          flex: none;
          display: inline-flex; align-items: center; justify-content: center;
          width: 26px; height: 26px; margin-top: 1px;
          border-radius: 50%;
          color: var(--glow-blue);
          background: linear-gradient(var(--paper-raise), var(--paper-raise)) padding-box,
            var(--grad-jelly) border-box;
          border: 1px solid transparent;
        }
        .nt-point__check svg { width: 15px; height: 15px; }

        /* —— 右侧 mock —— */
        .nt-visual {
          position: relative; min-width: 0;
          display: flex; flex-direction: column; gap: 16px;
          align-items: stretch;
        }
        .nt-halo { width: 64%; height: 60%; top: -6%; right: 6%; z-index: 0; }

        /* 捕捉浮层：置顶小窗，强浮起 */
        .nt-overlay {
          position: relative; z-index: 1;
          padding: 14px 15px 13px;
          border-radius: var(--r-lg);
          box-shadow: var(--shadow-pop);
          max-width: 380px; width: 100%;
          margin-inline: auto;
        }
        .nt-overlay__head { display: flex; align-items: center; gap: 9px; }
        .nt-dot { background: var(--clay); box-shadow: 0 0 0 3px var(--clay-soft); }
        .nt-overlay__title { font-weight: 650; font-size: var(--fs-sm); color: var(--ink); }
        .nt-kbd {
          margin-left: auto; font-size: 0.7rem; color: var(--ink-2);
          background: var(--paper-sink);
          border: 1px solid var(--line);
          border-bottom-width: 2px;
          border-radius: 6px; padding: 2px 8px;
        }
        .nt-overlay__ph {
          color: var(--ink-3); font-size: var(--fs-sm);
          padding: 14px 2px 16px;
          border-bottom: 1px dashed var(--line);
          margin-bottom: 12px;
          display: flex; align-items: center;
        }
        /* 输入光标:闪烁,呼应「随手记一笔」 */
        .nt-caret {
          display: inline-block; width: 1.5px; height: 1.05em;
          margin-left: 2px; background: var(--clay);
          animation: ntCaret 1.1s steps(1) infinite;
        }
        @keyframes ntCaret {
          0%, 50% { opacity: 1; }
          50.01%, 100% { opacity: 0; }
        }
        .nt-overlay__foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .nt-proj { font-size: 0.74rem; padding: 4px 11px 4px 9px; }
        .nt-proj .dot { background: var(--glow-blue); }
        .nt-proj .mono { font-size: 0.74rem; }
        /* 保存按钮为纯展示：取消交互错觉 */
        .nt-save { padding: 7px 16px; font-size: 0.82rem; pointer-events: none; cursor: default; }

        /* 深化状态流 */
        .nt-flow {
          position: relative; z-index: 1;
          display: flex; align-items: center; justify-content: center;
          gap: 10px; flex-wrap: wrap;
        }
        .nt-stage {
          font-size: 0.78rem; font-weight: 600;
          padding: 6px 13px; border-radius: var(--r-pill);
          background: var(--paper-raise);
          border: 1px solid var(--line);
          color: var(--ink-2);
        }
        .nt-stage--active {
          border-color: transparent; color: var(--clay-deep);
          background: linear-gradient(var(--paper-raise), var(--paper-raise)) padding-box,
            var(--grad-jelly) border-box;
        }
        .nt-stage--done {
          color: #fff; border-color: transparent;
          background: var(--ok);
        }
        .nt-flow__arrow { color: var(--ink-3); font-size: 0.9rem; }

        /* 产出文档 chip */
        .nt-outputs {
          position: relative; z-index: 1;
          display: flex; align-items: center; justify-content: center; gap: 10px; flex-wrap: wrap;
        }
        .nt-file {
          font-size: 0.74rem; color: var(--ink-2);
          background: var(--paper-sink);
          border: 1px solid var(--line);
          border-radius: var(--r-sm);
          padding: 6px 11px;
        }
        .nt-file::before {
          content: "›_"; color: var(--glow-blue); margin-right: 7px; opacity: 0.7;
        }

        /* —— 动画 —— */
        /* 「深化中」状态轻脉冲,暗示 agent 正在孵化 */
        .nt-stage--active { animation: ntStagePulse 2.4s var(--ease) infinite; }
        @keyframes ntStagePulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(91, 140, 255, 0); }
          50% { box-shadow: 0 0 0 4px rgba(91, 140, 255, 0.14); }
        }
        /* 产出文档 chip:滚动进入视口(.is-visible)后顺序淡入 */
        .nt-file {
          opacity: 0; transform: translateY(5px);
          animation: ntFileIn 0.5s var(--ease-out) forwards paused;
        }
        .nt-file:nth-child(1) { animation-delay: 0.2s; }
        .nt-file:nth-child(2) { animation-delay: 0.42s; }
        .reveal.is-visible .nt-file { animation-play-state: running; }
        @keyframes ntFileIn { to { opacity: 1; transform: none; } }

        /* —— 移动端：单列，文案在上、mock 在下 —— */
        @media (max-width: 860px) {
          .nt-grid { grid-template-columns: 1fr; gap: 32px; }
          .nt-visual { order: 2; }
        }

        /* reduced-motion:停在静态终态 */
        @media (prefers-reduced-motion: reduce) {
          .nt-caret { animation: none; opacity: 1; }
          .nt-stage--active { animation: none; }
          .nt-file { opacity: 1 !important; transform: none !important; animation: none !important; }
        }
      `}</style>
    </section>
  );
}
