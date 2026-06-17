// 阶段3 深度定制:把「工具执行审批 hook / 自定义工具 / 自定义斜杠命令」渲染成 pi extension,
// 经 -e 加载。与 pi-providers.ts 的 provider extension **独立共存**（pi:open 各生成一个文件、
// buildRpcArgs 各加一个 -e;provider 注入逻辑不动）。
//
// 模板法与 pi-providers 一致:纯函数 renderXxx()（便于单测字符串结构）+ writeXxx() 落盘
// userData/pi-extensions/（mode 0600）。default export `function (pi)`,runtime 注入 pi,
// 文件零 import（spike 已证 registerTool 用普通 JSON 对象 parameters 即可,无需 typebox)。

import { app } from "electron";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// 默认需审批的工具（写/执行类高风险操作）。
export const DEFAULT_APPROVAL_TOOLS = ["bash", "write", "edit"];

// 审批 hook extension:拦 tool_call,对需审批工具经 ctx.ui.confirm() 弹窗,拒绝则 block。
// ctx.hasUI=false（如纯 json 模式）时放行——审批是 UI 能力,无 UI 不阻断正常运行。
export function renderApprovalExtension(tools: string[] = DEFAULT_APPROVAL_TOOLS): string {
  return [
    "// 由 Cortex Desktop 自动生成（工具执行审批 hook）,请勿手改。",
    `const NEEDS = new Set(${JSON.stringify(tools)});`,
    "export default function (pi) {",
    "  pi.on(\"tool_call\", async (event, ctx) => {",
    "    if (!NEEDS.has(event.toolName)) return;",
    "    if (!ctx.hasUI) return;",
    "    const detail = (() => { try { return JSON.stringify(event.input).slice(0, 200); } catch { return \"\"; } })();",
    "    const ok = await ctx.ui.confirm(\"允许执行工具 \" + event.toolName + \"?\", detail);",
    "    if (!ok) return { block: true, reason: \"用户拒绝执行\" };",
    "  });",
    "}",
    "",
  ].join("\n");
}

// 自定义工具样例:registerTool（普通 JSON 对象 parameters,spike 已证可用;execute 返回 content）。
export function renderCustomToolExtension(): string {
  return [
    "// 由 Cortex Desktop 自动生成（自定义工具样例 echo_upper）,请勿手改。",
    "export default function (pi) {",
    "  pi.registerTool({",
    "    name: \"echo_upper\",",
    "    description: \"把输入文本转成大写返回（Cortex 自定义工具样例）\",",
    "    parameters: { type: \"object\", properties: { text: { type: \"string\" } }, required: [\"text\"] },",
    "    async execute(toolCallId, params) {",
    "      const text = params && typeof params.text === \"string\" ? params.text : \"\";",
    "      return { content: [{ type: \"text\", text: text.toUpperCase() }], isError: false };",
    "    },",
    "  });",
    "}",
    "",
  ].join("\n");
}

// 自定义斜杠命令样例:registerCommand（handler 调 ctx.ui.notify;无回写需求）。
export function renderSlashCommandExtension(): string {
  return [
    "// 由 Cortex Desktop 自动生成（自定义斜杠命令样例 /greet）,请勿手改。",
    "export default function (pi) {",
    "  pi.registerCommand(\"greet\", {",
    "    description: \"打个招呼（Cortex 自定义命令样例）\",",
    "    handler: async (args, ctx) => {",
    "      if (ctx.ui && ctx.ui.notify) ctx.ui.notify(\"hello \" + (args || \"\"), \"info\");",
    "    },",
    "  });",
    "}",
    "",
  ].join("\n");
}

// 落盘 extension 文件,返回绝对路径。固定文件名（无 per-instance 状态,每次 open 覆盖重写）。
function writeExtension(name: string, content: string): string {
  const dir = join(app.getPath("userData"), "pi-extensions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.js`);
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

export function writeApprovalExtension(tools?: string[]): string {
  return writeExtension("approval", renderApprovalExtension(tools));
}

export function writeCustomToolExtension(): string {
  return writeExtension("sample-tools", renderCustomToolExtension());
}

export function writeSlashCommandExtension(): string {
  return writeExtension("sample-commands", renderSlashCommandExtension());
}
