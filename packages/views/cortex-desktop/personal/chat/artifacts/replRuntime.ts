// javascript_repl 的渲染端一次性执行器 + 输出格式化（纯函数部分可独立单测;iframe 执行
// jsdom 测不了,由端到端冒烟覆盖）。
//
// 执行形态:每次执行建一个隐藏的沙箱 iframe(SandboxedIframe 同源的 buildSandboxSrcdoc,
// mode:"repl"),收 done/error/console 帧后立即销毁——不经 React,执行与 UI 树解耦
//（会话切换/面板开合不中断执行,结果只认 execId 回写）。

import {
  buildSandboxSrcdoc,
  parsePiSandboxMessage,
  type PiSandboxConsoleEntry,
} from "./sandboxHtml";

/** 执行结果(回写 pi 的 {value} 信封形状,见 core/desktop/types.ts JsReplEnvelope 注释)。 */
export interface ReplExecResult {
  ok: boolean;
  output: string;
}

/**
 * 汇总执行输出为回流模型的文本:console 行(warn/error 带前缀)+ 返回值 + 错误。
 * 纯函数,单测锁格式——模型侧的可读性依赖它。
 */
export function formatReplOutput(
  entries: PiSandboxConsoleEntry[],
  returnValue: string | undefined,
  error: { message: string; stack?: string } | undefined,
): string {
  const lines: string[] = entries.map((e) =>
    e.level === "error" ? `[error] ${e.text}` : e.level === "warn" ? `[warn] ${e.text}` : e.text,
  );
  if (returnValue !== undefined) lines.push(`=> ${returnValue}`);
  if (error) lines.push(error.stack ? `${error.message}\n${error.stack}` : error.message);
  if (!lines.length) return "(无输出)";
  return lines.join("\n");
}

export interface ReplExecHandle {
  promise: Promise<ReplExecResult>;
  /** 主动中止(hook 卸载/会话清理):以 ok:false 结算并销毁 iframe。 */
  abort: () => void;
}

/**
 * 在隐藏沙箱 iframe 里执行一段 JS。超时/中止都以 ok:false 结算,绝不悬挂
 * (worker 侧还有 120s 兜底,这里的 timeout 是第一道更快的闸)。
 */
export function runReplExec(code: string, execId: string, timeoutMs: number): ReplExecHandle {
  const entries: PiSandboxConsoleEntry[] = [];
  let lastError: { message: string; stack?: string } | undefined;
  let settle!: (r: ReplExecResult) => void;
  const promise = new Promise<ReplExecResult>((resolve) => {
    settle = resolve;
  });

  const sandboxId = `repl-${execId}`;
  const container = document.createElement("div");
  // 不用 display:none:部分引擎会跳过隐藏 iframe 的布局与脚本调度,用零尺寸 + 移出视口更稳。
  container.style.cssText = "position:fixed;width:0;height:0;overflow:hidden;left:-9999px;top:0;";
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.srcdoc = buildSandboxSrcdoc({ mode: "repl", code, sandboxId });

  let done = false;
  const finish = (result: ReplExecResult): void => {
    if (done) return;
    done = true;
    window.removeEventListener("message", onMessage);
    clearTimeout(timer);
    container.remove();
    settle(result);
  };

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) return;
    const msg = parsePiSandboxMessage(event.data, sandboxId);
    if (!msg) return;
    if (msg.kind === "console") entries.push(msg.entry);
    else if (msg.kind === "error") lastError = { message: msg.message, ...(msg.stack ? { stack: msg.stack } : {}) };
    else if (msg.kind === "done") {
      finish({
        ok: msg.ok,
        output: formatReplOutput(entries, msg.returnValue, msg.ok ? undefined : lastError),
      });
    }
    // repl 执行不响应 open-external:无头执行没有用户手势语境,静默忽略。
  };

  const timer = setTimeout(() => {
    finish({ ok: false, output: formatReplOutput(entries, undefined, { message: `执行超时（${Math.round(timeoutMs / 1000)}s）` }) });
  }, timeoutMs);

  window.addEventListener("message", onMessage);
  container.appendChild(iframe);
  document.body.appendChild(container);

  return {
    promise,
    abort: () => finish({ ok: false, output: "执行已中止" }),
  };
}
