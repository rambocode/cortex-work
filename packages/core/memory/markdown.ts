// 用户记忆 markdown 文件格式的纯逻辑层（平移自 core/reply/memory-files.ts 的成熟形态）：
// 每个分区一个 .md 文件（~/.cortex-desktop/memory/<scope>.md），用户可直接在 Finder 编辑——
//   - 「## ⟨auto⟩」标记行**上方**是手写区（manual，优先级最高），**下方**是做梦自动整理区（auto）；
//   - 文件头 HTML 注释是引导模板，注入 prompt 时经 stripUserMemoryComments 剥离，不进模型；
//   - parse/render 严格往返：设置页/做梦写回不破坏用户手写内容（含注释）。
// 文件系统读写在 main 侧 memory/memory-store.ts，此处只管文本格式。

import type { UserMemoryFile, UserMemoryScope } from "./memory";

/// 自动整理区标记行。parse 按「## ⟨auto⟩」前缀识别（兼容用户改动说明后缀），render 恒写完整形态。
export const USER_MEMORY_AUTO_MARKER = "## ⟨auto⟩ 做梦整理从你的会话中学到的（手写内容在上方，优先级更高）";
/// 已批准研究记忆区的标记行（spec §14.2）。同样按前缀宽松识别。
export const USER_MEMORY_RESEARCH_MARKER =
  "## ⟨research⟩ 你逐条批准写入的研究结论（每条都可回溯到来源；做梦不会改动这一段）";

/// 标记行识别前缀（宽松匹配，容忍后缀被编辑）。
const AUTO_MARKER_PREFIX = "## ⟨auto⟩";
const RESEARCH_MARKER_PREFIX = "## ⟨research⟩";

/// 解析 .md 全文为 {manual, auto, research}：两条标记行把文件切成三段。
///
/// **向后兼容是硬约束**：三段化之前的文件只有「## ⟨auto⟩」一条标记行，
/// 此时 research 段为空；两条标记行都没有时全文归 manual（手动创建的纯笔记文件也能读）。
export function parseUserMemoryMarkdown(text: string): UserMemoryFile {
  const lines = text.split("\n");
  const autoIndex = lines.findIndex((line) => line.trim().startsWith(AUTO_MARKER_PREFIX));
  const researchIndex = lines.findIndex((line) => line.trim().startsWith(RESEARCH_MARKER_PREFIX));

  if (autoIndex < 0 && researchIndex < 0) {
    return { manual: text.trim(), auto: "", research: "" };
  }
  // 只有 research 标记（用户手改掉了 auto 标记）：标记行之上全归 manual。
  if (autoIndex < 0) {
    return {
      manual: lines.slice(0, researchIndex).join("\n").trim(),
      auto: "",
      research: lines.slice(researchIndex + 1).join("\n").trim(),
    };
  }
  // 只有 auto 标记：旧格式文件，标记行之下全归 auto。
  if (researchIndex < 0) {
    return {
      manual: lines.slice(0, autoIndex).join("\n").trim(),
      auto: lines.slice(autoIndex + 1).join("\n").trim(),
      research: "",
    };
  }
  // 两条都有。render 恒按 manual → auto → research 排布，但用户可能手工调换顺序，
  // 所以按两个下标的先后切段，而不是假定 auto 一定在前。
  const [first, second] = autoIndex < researchIndex ? [autoIndex, researchIndex] : [researchIndex, autoIndex];
  const firstBody = lines.slice(first + 1, second).join("\n").trim();
  const secondBody = lines.slice(second + 1).join("\n").trim();
  return {
    manual: lines.slice(0, first).join("\n").trim(),
    auto: autoIndex < researchIndex ? firstBody : secondBody,
    research: autoIndex < researchIndex ? secondBody : firstBody,
  };
}

/// 渲染 {manual, auto, research} 为 .md 全文。
///
/// 两条标记行**恒写**（即便该段为空）：用户打开文件即见完整分区结构，
/// 也保证 parse/render 往返稳定（少写一条标记行会让下一次 parse 把两段并成一段）。
export function renderUserMemoryMarkdown(file: UserMemoryFile): string {
  const manual = file.manual.trim();
  const auto = file.auto.trim();
  const research = (file.research ?? "").trim();
  const head = manual.length > 0 ? `${manual}\n\n` : "";
  const autoBody = auto.length > 0 ? `\n${auto}\n` : "\n";
  const researchBody = research.length > 0 ? `\n${research}\n` : "\n";
  return `${head}${USER_MEMORY_AUTO_MARKER}\n${autoBody}\n${USER_MEMORY_RESEARCH_MARKER}\n${researchBody}`;
}

// 各分区新文件的引导模板（全部为 HTML 注释——注入 prompt 时被剥离，不污染模型输入）。
const SCOPE_TEMPLATES: Record<UserMemoryScope, string> = {
  profile: `<!--
用户画像 — 关于「你是谁」的稳定事实（身份/角色/公司/背景/关键的人）。
在这条注释下面手写补充，注释本身不会进 prompt；下方 auto 区由做梦整理自动维护。
-->`,
  preferences: `<!--
偏好习惯 — 稳定的偏好（沟通风格/语言习惯/技术栈与工具/工作方式）。
在这条注释下面手写补充，注释本身不会进 prompt；下方 auto 区由做梦整理自动维护。
-->`,
  projects: `<!--
项目背景 — 正在进行的项目与长期目标（名称/目标/约束/进展）。
在这条注释下面手写补充，注释本身不会进 prompt；下方 auto 区由做梦整理自动维护。
-->`,
};

/// 分区新文件的初始内容：引导注释 + 空自动区（manual 仅注释，剥离后为空，不污染 prompt）。
export function userMemoryFileTemplate(scope: UserMemoryScope): string {
  return renderUserMemoryMarkdown({ manual: SCOPE_TEMPLATES[scope], auto: "", research: "" });
}

/// 剥离 HTML 注释（引导模板/用户自己写的注释），供注入 prompt 用；同时收敛多余空行。
export function stripUserMemoryComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
