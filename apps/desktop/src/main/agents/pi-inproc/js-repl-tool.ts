// javascript_repl 工具（pi-web-ui 移植）。LLM 写一段 JS,由**渲染进程的沙箱 iframe** 执行,
// console 输出/返回值/错误回流为 tool result。
//
// ── 执行链路（askquestion 同款「sentinel + ctx.ui.input 借道」,零新 IPC 通道）──────────
// execute → ctx.ui.input(JSREPL_SENTINEL + JSON信封, …, {signal, timeout}) → ui-context.ts 的
// normalizeUiRequest 命中 sentinel 归一为 PiUiRequest{method:"jsrepl"} → gateway uiRequest →
// pi-session.ts → 渲染端沙箱执行 → piUiResponse {value: JSON({ok, output})} → dialog settle。
// 超时/abort/会话 stop/worker 崩溃的清理全部由 ui-context 的 dialog pending 机制承接
//（abort → resolve undefined;stop → cancelAll;renderer 销毁 → 立即 cancelled）。
//
// 安全边界:渲染端契约要求 code 只进无 allow-same-origin 的沙箱 iframe（opaque origin,无 Node、
// 无 bridge）;sentinel 为每会话高熵 token,防伪造裸 input 触发执行。缺 sentinel 不注册本工具。

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** 工具名。与 packages/core/desktop/types.ts 的 JS_REPL_TOOL_NAME 字面一致（worker 不 import core）。 */
export const JS_REPL_TOOL_NAME = "javascript_repl";

/** code 入参上限（与 rpc-shared.ts 的 sanitizeJsReplEnvelope 上限对称,两处同改）。 */
export const JS_REPL_MAX_CODE_BYTES = 256 * 1024;

/** 回流给模型的输出上限:执行产物可能是大 JSON,截断防撑爆上下文。 */
export const JS_REPL_MAX_OUTPUT_CHARS = 32 * 1024;

/** worker 侧兜底超时（渲染端沙箱自身另有更短的执行超时,这里只防「渲染端失联不回写」）。 */
export const JS_REPL_TIMEOUT_MS = 120_000;

const JS_REPL_PARAMS: ToolDefinition["parameters"] = {
  type: "object",
  properties: {
    title: { type: "string", description: "一句话描述这段代码做什么" },
    code: { type: "string", description: "待执行的 JavaScript 代码" },
  },
  required: ["title", "code"],
};

const JS_REPL_DESCRIPTION = `在沙箱浏览器环境中执行 JavaScript 并返回 console 输出与结果。

## 何时使用
- 数据处理/计算/转换(解析 JSON、统计、格式转换)
- 验证一段逻辑的实际行为
- fetch 公开 https 接口并加工返回数据

## 执行环境
- 浏览器沙箱 iframe:标准 Web API(fetch/DOMParser/crypto 等)可用
- 无 Node、无文件系统、无 localStorage/sessionStorage
- 顶层代码包在 async 函数中,可直接 await;用 return 返回最终结果(会随 console 输出一并回传)
- 用 console.log 输出中间结果;输出过长会被截断

## 注意
- 代码必须自包含,不依赖上一次调用的变量(每次执行都是全新环境)
- 长任务(>30s)会被超时中断`;

/**
 * 创建 javascript_repl 工具。sentinel 由 pi:open 生成、经 capabilities.ts 注入;
 * 渲染端回写形状 {ok, output} 见 core/desktop/types.ts 的 JsReplEnvelope 注释。
 */
export function createJsReplTool(sentinel: string): ToolDefinition {
  return {
    name: JS_REPL_TOOL_NAME,
    label: "JS 沙箱",
    description: JS_REPL_DESCRIPTION,
    parameters: JS_REPL_PARAMS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const p = (params ?? {}) as { title?: unknown; code?: unknown };
      const code = typeof p.code === "string" ? p.code : "";
      // 错误一律 throw（0.82.1 丢弃 isError 字段,见 native-hooks.ts 文件头）。
      if (!code.trim()) throw new Error("Error: code is required");
      if (Buffer.byteLength(code, "utf8") > JS_REPL_MAX_CODE_BYTES) {
        throw new Error(`Error: code exceeds ${JS_REPL_MAX_CODE_BYTES / 1024}KB limit`);
      }
      const title = typeof p.title === "string" ? p.title : "";

      let value: string | undefined;
      try {
        value = await ctx.ui.input(sentinel + JSON.stringify({ title, code }), undefined, {
          ...(signal ? { signal } : {}),
          timeout: JS_REPL_TIMEOUT_MS,
        });
      } catch (err) {
        throw new Error(`Error: repl 执行通道异常: ${err instanceof Error ? err.message : String(err)}`);
      }

      // undefined = 超时 / abort / 会话终止 / 渲染端取消（dialog 按默认值结算,不区分来源）。
      if (value === undefined || value === null) {
        throw new Error("Error: javascript_repl 执行未完成（超时或会话中断）");
      }

      let parsed: { ok?: unknown; output?: unknown };
      try {
        parsed = JSON.parse(value) as typeof parsed;
      } catch {
        throw new Error("Error: 无法解析执行结果");
      }
      const output = typeof parsed.output === "string" ? parsed.output : "";
      const truncated =
        output.length > JS_REPL_MAX_OUTPUT_CHARS
          ? output.slice(0, JS_REPL_MAX_OUTPUT_CHARS) + "\n…(输出已截断)"
          : output;
      // ok:false = 代码抛错/执行失败——对模型是可纠偏错误(带错误栈),throw 使 isError=true。
      if (parsed.ok !== true) throw new Error(truncated || "Error: 执行失败（无输出）");
      return {
        content: [{ type: "text" as const, text: truncated || "(无输出)" }],
        details: undefined,
      };
    },
  };
}
