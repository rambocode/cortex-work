/* =========================================================================
   SkillShowcase · 按需拖曳 Skill，省 token（差异化核心，id="skills"）
   server 组件。两列：左为「纯 div 自绘」的演示 mock（Prompt 库 → 拖入 composer），
   右为文案。mock 演示产品真实 UX：
     - 上：Prompt 库面板，列出本地 .md skill（带拖拽手柄）
     - 中：拖拽提示（一个 skill 被拖向输入框）
     - 下：composer —— 顶部 SK 引用 pill（真实 skill 名）、占位文案、
           底部「Agent 自带 Skills = 关」开关 + 精简的上下文条
   颜色全部走 globals.css token；可见文案来自 d.skills（含 mock 标签）。
   整块 mock 设 aria-hidden（纯演示），语义由右侧文案承载。
   ========================================================================= */

import { IconCheck } from "@/components/icons";
import type { Dict } from "@/lib/dictionary";
import type { Locale } from "@/lib/i18n";

export default function SkillShowcase({ d }: { d: Dict; locale: Locale }) {
  const s = d.skills;
  const m = s.mock;

  return (
    <section id="skills" className="section">
      <div className="container sk-grid">
        {/* ——— 左：拖曳 skill 演示 mock ——— */}
        <div className="sk-visual" aria-hidden="true">
          <span className="halo sk-halo" />
          <div className="card sk-stage">
            {/* Prompt 库面板 */}
            <div className="sk-lib">
              <div className="sk-lib__head">
                <span className="sk-lib__title">{m.panel}</span>
                <span className="sk-lib__count mono">{m.items.length}</span>
              </div>
              <ul className="sk-lib__list">
                {m.items.map((it, i) => (
                  <li key={it} className={`sk-skill${i === 0 ? " sk-skill--drag" : ""}`}>
                    <span className="sk-grip">
                      <span /><span /><span />
                      <span /><span /><span />
                    </span>
                    <span className="sk-skill__name mono">{it}</span>
                    {i === 0 && <span className="sk-skill__md mono">.md</span>}
                  </li>
                ))}
              </ul>
            </div>

            {/* 拖拽提示：一个 skill 正被拖向下方输入框 */}
            <div className="sk-drag">
              <span className="sk-drag__chip mono">
                <span className="sk-attach__badge">SK</span>
                {m.attach}
              </span>
              <span className="sk-drag__hint">{m.hint}</span>
            </div>

            {/* composer */}
            <div className="sk-composer">
              <div className="sk-attach">
                <span className="sk-attach__badge">SK</span>
                <span className="sk-attach__name mono">{m.attach}</span>
                <span className="sk-attach__x">×</span>
              </div>
              <p className="sk-composer__ph">{m.placeholder}</p>
              <div className="sk-composer__bar">
                <span className="sk-toggle">
                  <span className="sk-toggle__label">{m.toggle}</span>
                  <span className="sk-toggle__sw">
                    <span className="sk-toggle__knob" />
                  </span>
                  <span className="sk-toggle__state">{m.toggleState}</span>
                </span>
                <span className="sk-ctx">
                  <span className="sk-ctx__label">{m.context}</span>
                  <span className="sk-ctx__track">
                    <span className="sk-ctx__fill" />
                  </span>
                  <span className="sk-ctx__note muted">{m.contextNote}</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* ——— 右：文案 ——— */}
        <div className="sk-copy">
          <p className="eyebrow">{s.eyebrow}</p>
          <h2 className="h2 sk-copy__title">{s.title}</h2>
          <p className="lead sk-copy__sub">{s.sub}</p>
          <ul className="sk-points">
            {s.points.map((point, i) => (
              <li key={i} className="sk-point">
                <span className="sk-point__check" aria-hidden="true">
                  <IconCheck />
                </span>
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <style>{`
        .sk-grid {
          display: grid;
          grid-template-columns: 1.02fr 0.98fr;
          gap: clamp(28px, 4vw, 60px);
          align-items: center;
        }
        .sk-visual { position: relative; min-width: 0; }
        .sk-halo {
          width: 70%; height: 70%;
          top: 8%; left: 14%;
          z-index: 0;
        }
        .sk-stage {
          position: relative;
          z-index: 1;
          padding: clamp(16px, 2vw, 22px);
          display: flex;
          flex-direction: column;
          gap: 12px;
          background: var(--paper-sink);
        }

        /* —— Prompt 库面板（浮起） —— */
        .sk-lib {
          background: var(--paper-raise);
          border: 1px solid var(--line);
          border-radius: var(--r);
          box-shadow: var(--shadow-raise);
          padding: 12px 12px 8px;
        }
        .sk-lib__head {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 9px;
        }
        .sk-lib__title {
          font-size: var(--fs-eyebrow); font-weight: 600;
          letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2);
        }
        .sk-lib__count {
          font-size: 0.7rem; color: var(--ink-3);
          background: var(--paper-sink); border-radius: var(--r-pill);
          padding: 1px 7px;
        }
        .sk-lib__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
        .sk-skill {
          display: flex; align-items: center; gap: 9px;
          padding: 7px 8px; border-radius: var(--r-sm);
          color: var(--ink-2); font-size: var(--fs-sm);
        }
        .sk-skill__name { font-size: 0.8rem; color: var(--ink); }
        .sk-skill__md { font-size: 0.7rem; color: var(--ink-3); margin-left: -4px; }
        /* 第一条高亮：正被拖起 */
        .sk-skill--drag {
          background: var(--clay-soft);
          box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--clay) 40%, transparent);
        }
        .sk-skill--drag .sk-skill__name { color: var(--clay-deep); }
        /* 拖拽手柄：六点 */
        .sk-grip {
          flex: none;
          display: grid; grid-template-columns: repeat(2, 3px); gap: 2px;
          opacity: 0.55;
        }
        .sk-grip span { width: 3px; height: 3px; border-radius: 50%; background: var(--ink-3); }

        /* —— 拖拽提示 —— */
        .sk-drag {
          display: flex; align-items: center; gap: 10px;
          padding-left: 6px;
        }
        .sk-drag__chip {
          display: inline-flex; align-items: center; gap: 7px;
          font-size: 0.78rem; color: var(--clay-deep);
          background: var(--paper-raise);
          border: 1px dashed color-mix(in oklab, var(--clay) 55%, transparent);
          border-radius: var(--r-pill); padding: 5px 11px 5px 6px;
          box-shadow: var(--shadow-raise);
          /* 循环「拖向 composer」的手势:轻微下沉再回弹,暗示被拖入下方输入框 */
          transform: translateY(-2px) rotate(-3deg);
          animation: skChipDrag 3.6s var(--ease) infinite;
        }
        @keyframes skChipDrag {
          0%, 100% { transform: translateY(-2px) rotate(-3deg); box-shadow: var(--shadow-raise); }
          42%, 58% { transform: translateY(7px) rotate(-1deg); box-shadow: var(--shadow-pop); }
        }
        .sk-drag__hint {
          font-size: var(--fs-sm); color: var(--ink-3);
          position: relative; padding-left: 18px;
        }
        .sk-drag__hint::before {
          content: "↓"; position: absolute; left: 2px; top: -1px;
          color: var(--clay); font-weight: 700;
        }

        /* —— SK 徽标 —— */
        .sk-attach__badge {
          flex: none;
          display: inline-flex; align-items: center; justify-content: center;
          width: 22px; height: 18px; border-radius: 5px;
          background: var(--clay); color: #fff;
          font-size: 0.6rem; font-weight: 700; letter-spacing: 0.04em;
          font-family: var(--font-sans);
        }

        /* —— composer —— */
        .sk-composer {
          background: var(--paper-raise);
          border: 1px solid var(--line-strong);
          border-radius: var(--r);
          box-shadow: var(--shadow-raise);
          padding: 11px 12px 10px;
        }
        .sk-attach {
          display: inline-flex; align-items: center; gap: 7px;
          background: var(--paper-sink);
          border: 1px solid var(--line);
          border-radius: var(--r-pill);
          padding: 3px 9px 3px 4px; margin-bottom: 9px;
        }
        .sk-attach__name { font-size: 0.74rem; color: var(--ink); }
        .sk-attach__x { color: var(--ink-3); font-size: 0.9rem; line-height: 1; }
        .sk-composer__ph { color: var(--ink-3); font-size: var(--fs-sm); margin: 2px 2px 12px; }
        .sk-composer__bar {
          display: flex; align-items: center; justify-content: space-between;
          gap: 12px; flex-wrap: wrap;
          padding-top: 9px; border-top: 1px solid var(--line-soft);
        }
        /* Agent 自带 Skills 开关：关 */
        .sk-toggle { display: inline-flex; align-items: center; gap: 7px; font-size: 0.72rem; color: var(--ink-2); }
        .sk-toggle__sw {
          width: 26px; height: 15px; border-radius: var(--r-pill);
          background: var(--bg-active, var(--paper-chip));
          box-shadow: inset 0 0 0 1px var(--line-strong);
          position: relative; flex: none;
        }
        .sk-toggle__knob {
          position: absolute; top: 2px; left: 2px;
          width: 11px; height: 11px; border-radius: 50%;
          background: var(--ink-3);
        }
        .sk-toggle__state {
          font-weight: 700; color: var(--ink-3);
          font-size: 0.66rem; letter-spacing: 0.04em;
        }
        /* 上下文（token）条：默认精简 */
        .sk-ctx { display: inline-flex; align-items: center; gap: 8px; font-size: 0.72rem; color: var(--ink-2); }
        .sk-ctx__label { white-space: nowrap; }
        .sk-ctx__track {
          width: 64px; height: 6px; border-radius: var(--r-pill);
          background: var(--paper-sink);
          box-shadow: inset 0 0 0 1px var(--line);
          overflow: hidden;
        }
        .sk-ctx__fill {
          display: block; width: 22%; height: 100%; border-radius: var(--r-pill);
          background: var(--grad-jelly);
        }
        .sk-ctx__note { font-size: 0.66rem; white-space: nowrap; }

        /* —— 右侧文案要点 —— */
        .sk-copy__title { margin-top: 14px; text-wrap: balance; }
        .sk-copy__sub { margin-top: 14px; max-width: 46ch; }
        .sk-points { list-style: none; margin: 24px 0 0; padding: 0; display: flex; flex-direction: column; gap: 15px; }
        .sk-point { display: flex; align-items: flex-start; gap: 12px; color: var(--ink); }
        .sk-point__check {
          flex: none;
          display: inline-flex; align-items: center; justify-content: center;
          width: 26px; height: 26px; margin-top: 1px;
          border-radius: 50%;
          color: var(--glow-blue);
          background: linear-gradient(var(--paper-raise), var(--paper-raise)) padding-box,
            var(--grad-jelly) border-box;
          border: 1px solid transparent;
        }
        .sk-point__check svg { width: 15px; height: 15px; }

        /* —— 移动端：单列，mock 在上 —— */
        @media (max-width: 860px) {
          .sk-grid { grid-template-columns: 1fr; gap: 32px; }
        }
        @media (max-width: 480px) {
          .sk-composer__bar { gap: 10px; }
          .sk-ctx__track { width: 48px; }
        }

        /* reduced-motion:停在静态终态 */
        @media (prefers-reduced-motion: reduce) {
          .sk-drag__chip { animation: none; }
        }
      `}</style>
    </section>
  );
}
