"use client";

/* =========================================================================
   TerminalShowcase · 终端/文件预览 → 点击即引用进 Agent 输入框(client，id="terminal")
   真交互:左侧文件预览面板(可切文件、可点某一行) → 点击把 `文件:行` 或 `@文件`
   作为引用插进右下的 composer(Claude Code / Codex 可切),带精确上下文快速处理。
   一切可见文案来自 d.terminal(含文件名/代码行);引用格式在组件内拼接。
   动效:行 hover 高亮 + 引用 chip 入场;reduced-motion 下静默。
   ========================================================================= */

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconTerminal } from "@/components/icons";
import type { Dict } from "@/lib/dictionary";
import type { Locale } from "@/lib/i18n";

export default function TerminalShowcase({ d }: { d: Dict; locale: Locale }) {
  const t = d.terminal;
  const m = t.mock;

  const [agentKey, setAgentKey] = useState(m.agents[0].key);
  const [fileIdx, setFileIdx] = useState(0);
  const [refs, setRefs] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const file = m.files[fileIdx];
  const agentName = m.agents.find((a) => a.key === agentKey)!.name;

  const addRef = (ref: string) => {
    setSent(false);
    setRefs((prev) => (prev.includes(ref) ? prev : [...prev, ref]));
  };
  const removeRef = (ref: string) => setRefs((prev) => prev.filter((r) => r !== ref));

  const send = () => {
    if (!refs.length) return;
    setSent(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSent(false), 1800);
  };

  return (
    <section id="terminal" className="section">
      <div className="container tm-grid">
        {/* ——— 左:文件预览 + composer mock ——— */}
        <div className="tm-visual">
          <span className="halo tm-halo" />

          <div className="card tm-stage">
            {/* 文件预览面板 */}
            <div className="tm-files">
              <div className="tm-tabs" role="tablist">
                <span className="tm-tabs__icon" aria-hidden="true"><IconTerminal /></span>
                {m.files.map((f, i) => (
                  <button
                    key={f.name}
                    type="button"
                    role="tab"
                    aria-selected={i === fileIdx}
                    className={`tm-tab mono ${i === fileIdx ? "is-active" : ""}`}
                    onClick={() => setFileIdx(i)}
                  >
                    {f.name}
                  </button>
                ))}
              </div>

              <div className="tm-code">
                {file.lines.map((ln, i) => (
                  <button
                    key={i}
                    type="button"
                    className="tm-line"
                    onClick={() => addRef(`${file.name}:${i + 1}`)}
                  >
                    <span className="tm-ln mono" aria-hidden="true">{i + 1}</span>
                    <code className="tm-src mono">{ln}</code>
                    <span className="tm-line__add mono" aria-hidden="true">+ {file.name}:{i + 1}</span>
                  </button>
                ))}
              </div>

              <button
                type="button"
                className="tm-insertfile"
                onClick={() => addRef(`@${file.name}`)}
              >
                {m.insertFile} <span className="mono">@{file.name}</span>
              </button>
            </div>

            {/* composer:Claude Code / Codex,带插入的引用 */}
            <div className="tm-composer">
              <div className="tm-agents" role="tablist">
                {m.agents.map((a) => (
                  <button
                    key={a.key}
                    type="button"
                    role="tab"
                    aria-selected={a.key === agentKey}
                    className={`tm-agent ${a.key === agentKey ? "is-active" : ""}`}
                    onClick={() => setAgentKey(a.key)}
                  >
                    {a.name}
                  </button>
                ))}
              </div>

              <div className="tm-refs">
                {refs.length === 0 ? (
                  <span className="tm-empty">{m.empty}</span>
                ) : (
                  refs.map((r) => (
                    <span key={r} className="tm-ref mono">
                      {r}
                      <button
                        type="button"
                        className="tm-ref__x"
                        onClick={() => removeRef(r)}
                        aria-label={`remove ${r}`}
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
              </div>

              <p className="tm-ph">{m.placeholder}</p>

              <div className="tm-bar">
                <span className={`tm-sent ${sent ? "is-on" : ""}`} aria-live="polite">
                  {sent && (<><IconCheck /> {m.sent} {agentName}</>)}
                </span>
                <button type="button" className="tm-send" onClick={send} disabled={!refs.length}>
                  {m.send}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ——— 右:文案 ——— */}
        <div className="tm-copy">
          <p className="eyebrow">{t.eyebrow}</p>
          <h2 className="h2 tm-copy__title">{t.title}</h2>
          <p className="lead tm-copy__sub">{t.sub}</p>
          <ul className="tm-points">
            {t.points.map((point, i) => (
              <li key={i} className="tm-point">
                <span className="tm-point__check" aria-hidden="true"><IconCheck /></span>
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <style>{`
        .tm-grid {
          display: grid;
          grid-template-columns: 1.04fr 0.96fr;
          gap: clamp(28px, 4vw, 60px);
          align-items: center;
        }

        /* —— 左侧 mock —— */
        .tm-visual { position: relative; min-width: 0; }
        .tm-halo { width: 68%; height: 66%; top: 4%; left: 10%; z-index: 0; }
        .tm-stage {
          position: relative; z-index: 1;
          padding: clamp(14px, 1.8vw, 20px);
          display: flex; flex-direction: column; gap: 12px;
          background: var(--paper-sink);
        }

        /* 文件预览 */
        .tm-files {
          background: var(--paper-raise);
          border: 1px solid var(--line);
          border-radius: var(--r);
          box-shadow: var(--shadow-raise);
          overflow: hidden;
        }
        .tm-tabs {
          display: flex; align-items: center; gap: 4px;
          padding: 7px 8px;
          border-bottom: 1px solid var(--line);
          background: var(--paper-sink);
        }
        .tm-tabs__icon { display: inline-flex; color: var(--ink-3); margin-right: 2px; }
        .tm-tabs__icon svg { width: 15px; height: 15px; }
        .tm-tab {
          font-size: 0.74rem; color: var(--ink-3);
          padding: 4px 10px; border-radius: var(--r-sm);
          transition: color 0.18s var(--ease), background 0.18s var(--ease);
        }
        .tm-tab:hover { color: var(--ink-2); background: var(--paper-raise); }
        .tm-tab.is-active {
          color: var(--ink); background: var(--paper-raise);
          box-shadow: inset 0 0 0 1px var(--line);
        }

        .tm-code { padding: 6px 0; }
        .tm-line {
          display: flex; align-items: center; gap: 0;
          width: 100%; text-align: left;
          padding: 3px 12px 3px 0;
          position: relative;
          transition: background 0.15s var(--ease);
        }
        .tm-line:hover { background: var(--clay-soft); }
        .tm-ln {
          flex: none; width: 30px; text-align: right; padding-right: 12px;
          font-size: 0.72rem; color: var(--ink-3);
          user-select: none;
        }
        .tm-src {
          font-size: 0.76rem; color: var(--ink); white-space: pre;
          overflow: hidden; text-overflow: ellipsis; min-width: 0;
        }
        .tm-line__add {
          margin-left: auto; flex: none; padding-left: 10px;
          font-size: 0.68rem; color: var(--clay-deep);
          opacity: 0; transform: translateX(4px);
          transition: opacity 0.16s var(--ease), transform 0.16s var(--ease);
          white-space: nowrap;
        }
        .tm-line:hover .tm-line__add { opacity: 1; transform: none; }

        .tm-insertfile {
          display: block; width: 100%;
          text-align: left; padding: 8px 12px;
          font-size: 0.72rem; color: var(--ink-2);
          border-top: 1px solid var(--line);
          background: var(--paper-sink);
          transition: color 0.18s var(--ease), background 0.18s var(--ease);
        }
        .tm-insertfile:hover { color: var(--clay-deep); background: var(--clay-soft); }
        .tm-insertfile .mono { color: var(--ink); }
        .tm-insertfile:hover .mono { color: var(--clay-deep); }

        /* composer */
        .tm-composer {
          background: var(--paper-raise);
          border: 1px solid var(--line-strong);
          border-radius: var(--r);
          box-shadow: var(--shadow-raise);
          padding: 11px 12px 10px;
        }
        .tm-agents {
          display: inline-flex; gap: 2px;
          padding: 2px; margin-bottom: 9px;
          background: var(--paper-sink);
          border: 1px solid var(--line);
          border-radius: var(--r-pill);
        }
        .tm-agent {
          font-size: 0.72rem; font-weight: 600; color: var(--ink-3);
          padding: 4px 12px; border-radius: var(--r-pill);
          transition: color 0.18s var(--ease), background 0.18s var(--ease);
        }
        .tm-agent:hover { color: var(--ink-2); }
        .tm-agent.is-active {
          color: var(--clay-deep);
          background: var(--paper-raise);
          box-shadow: 0 1px 2px rgba(20,18,12,0.1);
        }

        .tm-refs {
          display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
          min-height: 28px; margin-bottom: 8px;
        }
        .tm-empty { font-size: 0.74rem; color: var(--ink-3); }
        .tm-ref {
          display: inline-flex; align-items: center; gap: 5px;
          font-size: 0.72rem; color: var(--clay-deep);
          background: var(--clay-soft);
          border-radius: var(--r-sm); padding: 3px 5px 3px 9px;
          animation: tmRefIn 0.25s var(--ease-out);
        }
        .tm-ref__x {
          display: inline-flex; align-items: center; justify-content: center;
          width: 15px; height: 15px; border-radius: 50%;
          color: var(--clay-deep); font-size: 0.85rem; line-height: 1;
        }
        .tm-ref__x:hover { background: color-mix(in oklab, var(--clay) 22%, transparent); }
        @keyframes tmRefIn { from { opacity: 0; transform: scale(0.85); } to { opacity: 1; transform: none; } }

        .tm-ph {
          font-size: var(--fs-sm); color: var(--ink-3);
          padding: 4px 2px 11px; margin: 0;
          border-bottom: 1px solid var(--line-soft);
        }
        .tm-bar {
          display: flex; align-items: center; justify-content: space-between;
          gap: 10px; padding-top: 10px;
        }
        .tm-sent {
          display: inline-flex; align-items: center; gap: 5px;
          font-size: 0.72rem; font-weight: 600; color: var(--ok);
          opacity: 0; transition: opacity 0.2s var(--ease);
        }
        .tm-sent.is-on { opacity: 1; }
        .tm-sent svg { width: 13px; height: 13px; }
        .tm-send {
          flex: none;
          font-size: 0.78rem; font-weight: 600; color: #fff;
          background: var(--clay);
          border-radius: var(--r-pill); padding: 6px 15px;
          box-shadow: 0 1px 2px rgba(20,18,12,0.18), 0 8px 18px -10px rgba(201,100,66,0.6);
          transition: background 0.18s var(--ease), transform 0.16s var(--ease), opacity 0.18s var(--ease);
        }
        .tm-send:hover:not(:disabled) { background: var(--clay-deep); transform: translateY(-1px); }
        .tm-send:disabled { opacity: 0.45; cursor: not-allowed; }

        /* —— 右侧文案要点 —— */
        .tm-copy__title { margin-top: 14px; text-wrap: balance; }
        .tm-copy__sub { margin-top: 14px; max-width: 46ch; }
        .tm-points { list-style: none; margin: 24px 0 0; padding: 0; display: flex; flex-direction: column; gap: 15px; }
        .tm-point { display: flex; align-items: flex-start; gap: 12px; color: var(--ink); }
        .tm-point__check {
          flex: none;
          display: inline-flex; align-items: center; justify-content: center;
          width: 26px; height: 26px; margin-top: 1px;
          border-radius: 50%;
          color: var(--glow-blue);
          background: linear-gradient(var(--paper-raise), var(--paper-raise)) padding-box,
            var(--grad-jelly) border-box;
          border: 1px solid transparent;
        }
        .tm-point__check svg { width: 15px; height: 15px; }

        /* —— 移动端:单列,mock 在上 —— */
        @media (max-width: 860px) {
          .tm-grid { grid-template-columns: 1fr; gap: 32px; }
          .tm-line__add { opacity: 0.7; }
        }

        @media (prefers-reduced-motion: reduce) {
          .tm-ref, .tm-line, .tm-line__add, .tm-send, .tm-tab, .tm-agent, .tm-insertfile, .tm-sent {
            animation: none; transition: none;
          }
        }
      `}</style>
    </section>
  );
}
