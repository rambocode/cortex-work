"use client";

/* =========================================================================
   HeroDemo · 首屏交互式演示卡(client）
   真交互:用户拖/点切换 skill → 在 composer 里输入 → 回车「运行」→ 模拟 Agent 输出。
     - code-review:逐行流式吐出一段评审
     - 会计录入:把输入里的「文字 + 金额」解析成结构化账目,逐行落入账本
   一切可见文案来自 d.heroDemo(双语);解析为「模拟」演示,不真正调用任何后端。
   动效:逐行/逐条出现 + 输入光标;reduced-motion 下直显全部、跳过等待。
   视觉沿用站点 token 与 composer 语言(.hd-* 前缀),叠在水母前方。
   ========================================================================= */

import { useEffect, useRef, useState } from "react";
import type { Dict } from "@/lib/dictionary";
import type { Locale } from "@/lib/i18n";

type Row = { date: string; cat: string; amount: string; account: string };

const prefersReduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** 把一段自然语言拆成账目条目:按分隔符切片,每片取末尾数字为金额,按关键词归类。 */
function parseLedger(text: string, d: Dict["heroDemo"]["ledger"], currency: string): Row[] {
  const segs = text
    .split(/[,，、;；\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const rows: Row[] = [];
  for (const seg of segs) {
    const m = seg.match(/(\d+(?:\.\d+)?)/);
    if (!m) continue;
    const note = seg.toLowerCase();
    const cat = d.cats.find((c) => c.match.some((k) => note.includes(k.toLowerCase())));
    rows.push({
      date: d.date,
      cat: cat ? cat.label : d.fallback,
      amount: `${currency}${m[1]}`,
      account: d.account,
    });
  }
  return rows;
}

export default function HeroDemo({ d, locale }: { d: Dict; locale: Locale }) {
  const hd = d.heroDemo;
  const currency = locale === "zh" ? "¥" : "$";

  const [skillKey, setSkillKey] = useState<"review" | "ledger">(hd.skills[0].key);
  const [value, setValue] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [phase, setPhase] = useState<"idle" | "thinking" | "result">("idle");
  const [shown, setShown] = useState(0); // 已揭示的行/条数
  const [rows, setRows] = useState<Row[]>([]);

  const skill = hd.skills.find((s) => s.key === skillKey)!;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // 清理所有计时器(切换/卸载/重新运行时)
  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  // 切换 skill:重置演示态
  const pickSkill = (k: "review" | "ledger") => {
    clearTimers();
    setSkillKey(k);
    setValue("");
    setPhase("idle");
    setShown(0);
    setRows([]);
  };

  // 运行:解析输入 → 思考 → 逐行/逐条流式揭示
  const run = () => {
    const text = value.trim() || skill.example;
    clearTimers();
    setShown(0);

    const reduced = prefersReduced();
    const total =
      skill.key === "review" ? hd.reviewLines.length : 0;
    let ledgerRows: Row[] = [];
    if (skill.key === "ledger") {
      ledgerRows = parseLedger(text, hd.ledger, currency);
      if (ledgerRows.length === 0) ledgerRows = parseLedger(skill.example, hd.ledger, currency);
      setRows(ledgerRows);
    }
    const count = skill.key === "review" ? total : ledgerRows.length;

    const reveal = () => {
      setPhase("result");
      if (reduced) {
        setShown(count);
        return;
      }
      for (let i = 1; i <= count; i++) {
        timers.current.push(setTimeout(() => setShown(i), i * 480));
      }
    };

    setPhase("thinking");
    timers.current.push(setTimeout(reveal, reduced ? 0 : 620));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      run();
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const k = e.dataTransfer.getData("text/skill");
    if (k === "review" || k === "ledger") pickSkill(k);
  };

  const ledgerDone = skill.key === "ledger" && phase === "result" && shown >= rows.length && rows.length > 0;

  return (
    <div className="hd">
      {/* skill 库:可拖拽的小 chip(点也能切换） */}
      <div className="hd-lib">
        <span className="hd-lib__hint">{hd.drag}</span>
        <div className="hd-lib__chips">
          {hd.skills.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`hd-chip mono ${s.key === skillKey ? "is-active" : ""}`}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("text/skill", s.key)}
              onClick={() => pickSkill(s.key)}
              aria-pressed={s.key === skillKey}
            >
              <span className="hd-chip__grip" aria-hidden="true">
                <span /><span /><span /><span /><span /><span />
              </span>
              {s.name}
            </button>
          ))}
        </div>
      </div>

      {/* composer */}
      <div
        className={`hd-composer ${dragOver ? "is-drop" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="hd-attach">
          <span className="hd-badge">SK</span>
          <span className="hd-attach__name mono">{skill.name}</span>
          <button
            type="button"
            className="hd-attach__swap"
            onClick={() => pickSkill(skillKey === "review" ? "ledger" : "review")}
            aria-label={hd.drag}
          >
            ⇄
          </button>
        </div>

        <textarea
          className="hd-input mono"
          rows={1}
          value={value}
          placeholder={skill.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label={skill.placeholder}
        />

        <div className="hd-bar">
          <button
            type="button"
            className="hd-try"
            onClick={() => setValue(skill.example)}
          >
            {hd.tryLabel} <span className="mono">{skill.example}</span>
          </button>
          <button type="button" className="hd-run" onClick={run}>
            {hd.send}
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      </div>

      {/* 输出区 */}
      {phase !== "idle" && (
        <div className="hd-out" aria-live="polite">
          {phase === "thinking" && (
            <div className="hd-think">
              <span className="hd-think__dot" />
              <span className="hd-think__dot" />
              <span className="hd-think__dot" />
              <span className="hd-think__label">{hd.thinking}</span>
            </div>
          )}

          {phase === "result" && skill.key === "review" && (
            <div className="hd-review">
              {hd.reviewLines.slice(0, shown).map((line, i) => (
                <p key={i} className="hd-review__line">{line}</p>
              ))}
            </div>
          )}

          {phase === "result" && skill.key === "ledger" && (
            <div className="hd-ledger">
              <div className="hd-ledger__head">
                {hd.ledger.cols.map((c) => (
                  <span key={c} className="hd-col">{c}</span>
                ))}
              </div>
              {rows.slice(0, shown).map((r, i) => (
                <div key={i} className="hd-row">
                  <span className="hd-cell mono">{r.date}</span>
                  <span className="hd-cell hd-cell--cat">{r.cat}</span>
                  <span className="hd-cell mono hd-cell--amt">{r.amount}</span>
                  <span className="hd-cell mono hd-cell--acct">{r.account}</span>
                </div>
              ))}
              {ledgerDone && (
                <div className="hd-done">
                  <span className="hd-done__badge">✓ {hd.ledger.done}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <style>{`
        .hd {
          display: flex; flex-direction: column; gap: 9px;
          width: 100%;
        }

        /* —— skill 库:可拖拽 chip —— */
        .hd-lib { display: flex; flex-direction: column; gap: 7px; }
        .hd-lib__hint { font-size: 0.72rem; color: var(--ink-3); padding-left: 2px; }
        .hd-lib__chips { display: flex; gap: 8px; flex-wrap: wrap; }
        .hd-chip {
          display: inline-flex; align-items: center; gap: 7px;
          font-size: 0.76rem; color: var(--ink-2);
          background: var(--paper-raise);
          border: 1px solid var(--line);
          border-radius: var(--r-pill);
          padding: 5px 12px 5px 8px;
          box-shadow: var(--shadow-xs);
          cursor: grab;
          transition: transform 0.16s var(--ease), box-shadow 0.2s var(--ease),
            border-color 0.2s var(--ease), color 0.2s var(--ease);
        }
        .hd-chip:hover { transform: translateY(-1px); box-shadow: var(--shadow-card); color: var(--ink); }
        .hd-chip:active { cursor: grabbing; }
        .hd-chip.is-active {
          color: var(--clay-deep);
          border-color: transparent;
          background: var(--clay-soft);
          box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--clay) 40%, transparent);
        }
        .hd-chip__grip {
          display: grid; grid-template-columns: repeat(2, 3px); gap: 2px; opacity: 0.5;
        }
        .hd-chip__grip span { width: 3px; height: 3px; border-radius: 50%; background: currentColor; }

        /* —— composer —— */
        .hd-composer {
          background: var(--paper-raise);
          border: 1px solid var(--line-strong);
          border-radius: var(--r-lg);
          box-shadow: var(--shadow-pop);
          padding: 12px 13px 11px;
          transition: border-color 0.2s var(--ease), box-shadow 0.2s var(--ease);
        }
        .hd-composer.is-drop {
          border-color: var(--clay);
          box-shadow: var(--shadow-pop), 0 0 0 3px var(--clay-soft);
        }
        .hd-attach {
          display: inline-flex; align-items: center; gap: 7px;
          background: var(--paper-sink);
          border: 1px solid var(--line);
          border-radius: var(--r-pill);
          padding: 3px 6px 3px 4px; margin-bottom: 9px;
        }
        .hd-badge {
          flex: none;
          display: inline-flex; align-items: center; justify-content: center;
          width: 22px; height: 18px; border-radius: 5px;
          background: var(--clay); color: #fff;
          font-size: 0.6rem; font-weight: 700; letter-spacing: 0.04em;
        }
        .hd-attach__name { font-size: 0.76rem; color: var(--ink); }
        .hd-attach__swap {
          display: inline-flex; align-items: center; justify-content: center;
          width: 18px; height: 18px; border-radius: var(--r-pill);
          color: var(--ink-3); font-size: 0.82rem; line-height: 1;
        }
        .hd-attach__swap:hover { color: var(--clay-deep); background: var(--paper-raise); }

        .hd-input {
          display: block; width: 100%; resize: none;
          border: none; outline: none; background: transparent;
          color: var(--ink); font-size: var(--fs-sm); line-height: 1.5;
          min-height: 1.5em; max-height: 5em;
          padding: 2px 2px 10px;
          font-family: var(--font-mono);
        }
        .hd-input::placeholder { color: var(--ink-3); }

        .hd-bar {
          display: flex; align-items: center; justify-content: space-between;
          gap: 10px;
          padding-top: 9px; border-top: 1px solid var(--line-soft);
        }
        .hd-try {
          min-width: 0; flex: 1;
          display: inline-flex; align-items: baseline; gap: 6px;
          font-size: 0.7rem; color: var(--ink-3);
          text-align: left;
        }
        .hd-try .mono {
          font-size: 0.7rem; color: var(--ink-2);
          overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
        }
        .hd-try:hover .mono { color: var(--clay-deep); }
        .hd-run {
          flex: none;
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 0.78rem; font-weight: 600; color: #fff;
          background: var(--clay);
          border-radius: var(--r-pill); padding: 6px 14px;
          box-shadow: 0 1px 2px rgba(20, 18, 12, 0.18), 0 8px 18px -10px rgba(201, 100, 66, 0.6);
          transition: background 0.18s var(--ease), transform 0.16s var(--ease);
        }
        .hd-run:hover { background: var(--clay-deep); transform: translateY(-1px); }
        .hd-run:active { transform: translateY(0); }

        /* —— 输出 —— */
        .hd-out {
          background: var(--paper-sink);
          border: 1px solid var(--line);
          border-radius: var(--r);
          padding: 10px 12px;
          max-height: 168px; overflow: auto;
        }
        /* 思考三点 */
        .hd-think { display: flex; align-items: center; gap: 6px; }
        .hd-think__dot {
          width: 6px; height: 6px; border-radius: 50%; background: var(--glow-blue);
          animation: hdDot 1.1s var(--ease) infinite;
        }
        .hd-think__dot:nth-child(2) { animation-delay: 0.18s; }
        .hd-think__dot:nth-child(3) { animation-delay: 0.36s; }
        .hd-think__label { font-size: 0.74rem; color: var(--ink-3); margin-left: 4px; }
        @keyframes hdDot {
          0%, 100% { opacity: 0.3; transform: translateY(0); }
          50% { opacity: 1; transform: translateY(-3px); }
        }

        /* code-review 逐行 */
        .hd-review { display: flex; flex-direction: column; gap: 5px; }
        .hd-review__line {
          font-size: 0.78rem; line-height: 1.5; color: var(--ink);
          animation: hdLineIn 0.42s var(--ease-out);
        }
        @keyframes hdLineIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

        /* 账本 */
        .hd-ledger__head, .hd-row {
          display: grid; grid-template-columns: 0.7fr 0.9fr 0.8fr 0.8fr;
          align-items: center; gap: 8px; padding: 6px 2px;
        }
        .hd-col {
          font-size: 0.62rem; font-weight: 600; letter-spacing: 0.06em;
          text-transform: uppercase; color: var(--ink-3);
        }
        .hd-row { border-top: 1px solid var(--line-soft); animation: hdLineIn 0.42s var(--ease-out); }
        .hd-cell { font-size: 0.78rem; color: var(--ink); }
        .hd-cell--cat { color: var(--ink-2); }
        .hd-cell--amt { color: var(--clay-deep); font-weight: 650; }
        .hd-cell--acct { color: var(--ink-3); }
        .hd-done { display: flex; justify-content: flex-end; padding-top: 8px; }
        .hd-done__badge {
          font-size: 0.7rem; font-weight: 600; color: var(--ok);
          background: var(--ok-soft); border-radius: var(--r-pill);
          padding: 3px 10px;
          animation: hdLineIn 0.4s var(--ease-out);
        }

        @media (prefers-reduced-motion: reduce) {
          .hd-think__dot { animation: none; opacity: 0.7; }
          .hd-review__line, .hd-row, .hd-done__badge { animation: none; }
        }
      `}</style>
    </div>
  );
}
