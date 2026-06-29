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

// 目录执行权限「仅工作目录」路径闸:pi 无原生沙箱(见 pi docs/security.md「No Built-in Sandbox」),
// 靠 tool_call hook 在工具执行**前**拦截,对越界路径 `return { block: true }`(无需 UI)。
//
// 判定逻辑集中在纯函数 evaluatePathJail(host 可直接单测),再经 Function.prototype.toString() 内联进生成的
// extension —— 二者**同源、零漂移**。extension 在 pi 进程内运行,把注入的 node:path/os 依赖喂给该函数,做与
// pi(utils/paths.js normalizePath/resolvePath)**完全一致**的解析:展开 `~`/`~/`→homedir、strip 前缀 `@`、
// 归一 unicode 空格,再按 isAbsolute 决定相对/绝对 resolve。**这是修复关键** —— 早前用裸 resolve 不展开 `~`,
// 导致 `~/Desktop` 被当成 cwd 下相对路径误判放行。
//
// 覆盖范围:
//  - 文件工具 read/write/edit/ls/grep/find:解析 input.path,落在 allowed roots(cwd + 已启用 skill 目录)外即拦。
//    含 skill 目录:否则 skill references(<skillDir>/references/,常以绝对路径 Read)会被误伤。
//  - bash:无结构化路径,改为高精度抽取命令里的「家目录引用」(`~`/`~/…`/`$HOME`/`${HOME}`/字面 home 前缀)逐个判界,
//    覆盖「访问工作目录外用户文件」这一最常见越权(如 `ls ~/Desktop`)。
// 已知限制:bash 仍非 bulletproof —— 绝对系统路径(/etc 等)与混淆命令拦不全;真正彻底隔离需 OS 级 sandbox
//(见 pi examples/extensions/sandbox,需 @anthropic-ai/sandbox-runtime + sandbox-exec/bubblewrap)。不解析符号链接。
//
// ⚠️ evaluatePathJail 必须**完全自包含**(只引用入参 + 字面量 + 全局 String/RegExp;不引用任何模块作用域符号),
//    否则 .toString() 内联后会在 extension 运行时 ReferenceError。改它时务必保持这一不变量。

// 纯判定:命中越界返回 { reason },否则 null。deps 注入 node:path 的 resolve/isAbsolute/join/sep;home=os.homedir()。
export function evaluatePathJail(
  deps: { resolve: (...p: string[]) => string; isAbsolute: (p: string) => boolean; join: (...p: string[]) => string; sep: string },
  toolName: string,
  input: { path?: unknown; command?: unknown } | undefined,
  cwd: string,
  roots: string[],
  home: string,
): { reason: string } | null {
  // 复刻 pi utils/paths.js normalizePath:归一 unicode 空格 + strip 前缀 @ + 展开 ~。
  const norm = (raw: string): string => {
    let s = String(raw).replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
    if (s.charAt(0) === "@") s = s.slice(1);
    if (s === "~") return home;
    if (s.slice(0, 2) === "~/" || s.slice(0, 2) === "~\\") return deps.join(home, s.slice(2));
    return s;
  };
  const toAbs = (raw: string): string => {
    const n = norm(raw);
    return deps.isAbsolute(n) ? deps.resolve(n) : deps.resolve(cwd, n);
  };
  const allowed = roots.map((r) => deps.resolve(r));
  const inRoots = (abs: string): boolean => {
    for (let i = 0; i < allowed.length; i++) {
      if (abs === allowed[i] || abs.indexOf(allowed[i] + deps.sep) === 0) return true;
    }
    return false;
  };
  const fileTools = ["read", "write", "edit", "ls", "grep", "find"];
  if (fileTools.indexOf(toolName) !== -1) {
    const p = input && input.path;
    if (typeof p !== "string" || p.length === 0) return null; // 缺省 path → 工具落 cwd,放行
    if (!inRoots(toAbs(p)))
      return { reason: "目录执行权限为「仅工作目录」,已拦截工作目录外的访问: " + p + "。如需放开,请在「自定义 → 目录执行权限」切到「所有文件」。" };
    return null;
  }
  if (toolName === "bash") {
    const cmd = input && input.command;
    if (typeof cmd !== "string" || cmd.length === 0) return null;
    const refs: string[] = [];
    let m: RegExpExecArray | null;
    const tildeRe = /(?:^|[\s=:"'`(])(~(?:\/[^\s"'`)]*)?)/g; // 词首的 ~ 或 ~/...
    while ((m = tildeRe.exec(cmd)) !== null) refs.push(m[1]);
    const homeVarRe = /\$\{?HOME\}?(\/[^\s"'`)]*)?/g; // $HOME / ${HOME} 及子路径
    while ((m = homeVarRe.exec(cmd)) !== null) refs.push(home + (m[1] || ""));
    if (cmd.indexOf(home) !== -1) {
      // 字面 home 前缀(如 /Users/xxx/...)
      const litRe = new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:/[^\\s\"'`)]*)?", "g");
      while ((m = litRe.exec(cmd)) !== null) refs.push(m[0]);
    }
    for (let i = 0; i < refs.length; i++) {
      if (!inRoots(toAbs(refs[i])))
        return { reason: "目录执行权限为「仅工作目录」,已拦截 bash 命令访问工作目录外的用户目录: " + refs[i] + "。如需放开,请切到「所有文件」。" };
    }
    return null;
  }
  return null;
}

export function renderPathJailExtension(roots: string[]): string {
  return [
    "// 由 Cortex Desktop 自动生成（目录执行权限「仅工作目录」路径闸）,请勿手改。",
    'import { homedir } from "node:os";',
    'import { isAbsolute, join, resolve, sep } from "node:path";',
    `const ROOTS = ${JSON.stringify(roots)};`,
    // 内联 host 端同源纯函数(零漂移);见上方 evaluatePathJail 的自包含不变量。
    `const evaluatePathJail = ${evaluatePathJail.toString()};`,
    "export default function (pi) {",
    '  pi.on("tool_call", async (event, ctx) => {',
    "    const v = evaluatePathJail({ resolve, isAbsolute, join, sep }, event.toolName, event.input, ctx.cwd, ROOTS, homedir());",
    "    if (v) return { block: true, reason: v.reason };",
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

// askquestion 提问工具的 parameters schema（给 LLM）。纯 JSON（无函数）,经 JSON.stringify 嵌入源码。
const ASK_QUESTION_PARAMS = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      description: "一组或多组问题。每组最多 3 个选项;可标推荐项;可允许用户自定义输入。",
      items: {
        type: "object",
        properties: {
          header: { type: "string", description: "简短标签(可选)" },
          question: { type: "string", description: "问题文本" },
          options: {
            type: "array",
            description: "候选项,最多 3 个",
            items: {
              type: "object",
              properties: { label: { type: "string" }, description: { type: "string" } },
              required: ["label"],
            },
          },
          recommended: { type: "number", description: "推荐选项的下标(从 0 开始,可选)" },
          allowCustom: { type: "boolean", description: "是否允许用户填写自定义回答(可选)" },
        },
        required: ["question", "options"],
      },
    },
  },
  required: ["groups"],
};

// askquestion 自定义工具:execute 内把多组问题信封经 ctx.ui.input 的 title 借「sentinel + JSON」抛给
// host（U0 实测 input.title 原样承载长 JSON 零截断;不在 session 生命周期 hook 调,避免死锁）,await
// 用户答案(value)/取消(undefined),return 含「逐组 问/答」的人类可读 result。sentinel 为每会话高熵
// token（由 pi:open 注入,防 LLM 在裸 input 的 title 里伪造）。零 import（普通对象 parameters,无 typebox）。
export function renderAskQuestionExtension(sentinel: string): string {
  return [
    "// 由 Cortex Desktop 自动生成（askquestion 提问工具）,请勿手改。",
    `const SENTINEL = ${JSON.stringify(sentinel)};`,
    `const PARAMS = ${JSON.stringify(ASK_QUESTION_PARAMS)};`,
    "function buildGroups(raw) {",
    "  const out = [];",
    "  for (let i = 0; i < raw.length; i++) {",
    "    const g = raw[i] || {};",
    "    const rawOpts = Array.isArray(g.options) ? g.options.slice(0, 3) : [];",
    "    const options = rawOpts.map((o) => {",
    "      const opt = { label: String(o && o.label != null ? o.label : o) };",
    "      if (o && o.description != null) opt.description = String(o.description);",
    "      return opt;",
    "    });",
    '    let recommended = typeof g.recommended === "number" ? g.recommended : undefined;',
    "    if (recommended != null && (recommended < 0 || recommended >= options.length)) recommended = undefined;",
    '    const group = { id: "g" + i, question: String(g.question != null ? g.question : ""), options: options, allowCustom: !!g.allowCustom };',
    "    if (g.header != null) group.header = String(g.header);",
    "    if (recommended != null) group.recommended = recommended;",
    "    out.push(group);",
    "  }",
    "  return out;",
    "}",
    "export default function (pi) {",
    "  pi.registerTool({",
    '    name: "askquestion",',
    '    description: "在确实需要用户做出选择或澄清时,向用户弹出一组或多组问题(每组最多 3 个选项,可标推荐项,可允许自定义输入)。仅在存在真实歧义、必须由用户裁决时调用;能自行决定的事项不要调用。",',
    "    parameters: PARAMS,",
    "    async execute(toolCallId, params, signal, onUpdate, ctx) {",
    "      const raw = params && Array.isArray(params.groups) ? params.groups : [];",
    '      if (!raw.length) return { content: [{ type: "text", text: "askquestion 调用未提供任何问题组。" }], isError: true };',
    // 与 host sanitizeAskQuestionEnvelope 的 ASKQ_MAX_GROUPS 对称:超限直接给 LLM 可纠偏的 isError 反馈,
    // 而非交给 host 拒绝后退化成笼统的「用户取消」(agent 据此可能重试同样过大的调用)。
    '      if (raw.length > 12) return { content: [{ type: "text", text: "问题组过多(最多 12 组),请精简后重试。" }], isError: true };',
    "      const groups = buildGroups(raw);",
    "      let value;",
    "      try { value = await ctx.ui.input(SENTINEL + JSON.stringify({ groups: groups })); }",
    '      catch (e) { return { content: [{ type: "text", text: "提问过程出错: " + String(e) }], isError: true }; }',
    '      if (value === undefined || value === null) return { content: [{ type: "text", text: "用户取消了提问,未作选择。" }], isError: false };',
    "      let parsed;",
    '      try { parsed = JSON.parse(value); } catch (e) { return { content: [{ type: "text", text: "无法解析用户的回答。" }], isError: true }; }',
    "      const answers = parsed && Array.isArray(parsed.answers) ? parsed.answers : [];",
    "      const qById = {};",
    "      for (const g of groups) qById[g.id] = g.question;",
    '      const lines = answers.map((a) => "问: " + (qById[a && a.groupId] || (a && a.groupId) || "?") + "\\n答: " + String(a && a.value != null ? a.value : "") + (a && a.isCustom ? "（自定义）" : ""));',
    '      const text = lines.length ? "用户回答如下:\\n" + lines.join("\\n\\n") : "用户未提供有效回答。";',
    '      return { content: [{ type: "text", text: text }], isError: false };',
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

// cwd 路径闸 extension（roots = cwd + 已启用 skill 目录）。固定文件名,与既有 extension 同款每 open 覆盖。
export function writePathJailExtension(roots: string[]): string {
  return writeExtension("path-jail", renderPathJailExtension(roots));
}

export function writeCustomToolExtension(): string {
  return writeExtension("sample-tools", renderCustomToolExtension());
}

export function writeSlashCommandExtension(): string {
  return writeExtension("sample-commands", renderSlashCommandExtension());
}

// askquestion 工具 extension（常驻;sentinel 每会话高熵,由 pi:open 生成传入）。
export function writeAskQuestionExtension(sentinel: string): string {
  return writeExtension("askquestion", renderAskQuestionExtension(sentinel));
}
