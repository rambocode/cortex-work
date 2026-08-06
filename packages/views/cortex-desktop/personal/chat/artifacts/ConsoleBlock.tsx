// 沙箱 console 输出条（HTML 产物预览与 REPL 执行共用):折叠展示,error/warn 计数在头部。

import React, { useState } from "react";

import type { PiSandboxConsoleEntry } from "./sandboxHtml";

export interface ConsoleBlockProps {
  entries: PiSandboxConsoleEntry[];
}

/** console 折叠条。无输出时不渲染任何内容。 */
export function ConsoleBlock({ entries }: ConsoleBlockProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  const errors = entries.filter((e) => e.level === "error").length;
  const warns = entries.filter((e) => e.level === "warn").length;
  return (
    <div className={`pw-pa-console${errors ? " is-error" : ""}`}>
      <button type="button" className="pw-pa-console-head" onClick={() => setOpen((v) => !v)}>
        <span>{open ? "▾" : "▸"} Console ({entries.length})</span>
        {errors > 0 && <span className="pw-pa-console-err">{errors} error</span>}
        {warns > 0 && <span className="pw-pa-console-warn">{warns} warn</span>}
      </button>
      {open && (
        <pre className="pw-pa-console-body">
          {entries.map((e, i) => (
            <div key={i} className={`pw-pa-console-line lv-${e.level}`}>
              {e.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
