// 用户记忆 markdown 文件格式的纯逻辑层（平移自 core/reply/memory-files.ts 的成熟形态）：
// 每个分区一个 .md 文件（~/.cortex-desktop/memory/<scope>.md），用户可直接在 Finder 编辑——
//   - 「## ⟨auto⟩」标记行**上方**是手写区（manual，优先级最高），**下方**是做梦自动整理区（auto）；
//   - 文件头 HTML 注释是引导模板，注入 prompt 时经 stripUserMemoryComments 剥离，不进模型；
//   - parse/render 严格往返：设置页/做梦写回不破坏用户手写内容（含注释）。
// 文件系统读写在 main 侧 memory/memory-store.ts，此处只管文本格式。

import type { UserMemoryFile, UserMemoryScope } from "./memory";

/// 自动整理区标记行。parse 按「## ⟨auto⟩」前缀识别（兼容用户改动说明后缀），render 恒写完整形态。
export const USER_MEMORY_AUTO_MARKER = "## ⟨auto⟩ 做梦整理从你的会话中学到的（手写内容在上方，优先级更高）";

/// 标记行识别前缀（宽松匹配，容忍后缀被编辑）。
const AUTO_MARKER_PREFIX = "## ⟨auto⟩";

/// 解析 .md 全文为 {manual, auto}：标记行上方 manual、下方 auto，双侧裁剪首尾空白；
/// 无标记行时全文归 manual（手动创建的纯笔记文件也能读）。
export function parseUserMemoryMarkdown(text: string): UserMemoryFile {
  const lines = text.split("\n");
  const markerIndex = lines.findIndex((line) => line.trim().startsWith(AUTO_MARKER_PREFIX));
  if (markerIndex < 0) {
    return { manual: text.trim(), auto: "" };
  }
  return {
    manual: lines.slice(0, markerIndex).join("\n").trim(),
    auto: lines.slice(markerIndex + 1).join("\n").trim(),
  };
}

/// 渲染 {manual, auto} 为 .md 全文。auto 为空也写标记行——用户打开文件即见分区结构，
/// 也保证 parse/render 往返稳定。
export function renderUserMemoryMarkdown(file: UserMemoryFile): string {
  const manual = file.manual.trim();
  const auto = file.auto.trim();
  const head = manual.length > 0 ? `${manual}\n\n` : "";
  const tail = auto.length > 0 ? `\n${auto}\n` : "\n";
  return `${head}${USER_MEMORY_AUTO_MARKER}\n${tail}`;
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
  return renderUserMemoryMarkdown({ manual: SCOPE_TEMPLATES[scope], auto: "" });
}

/// 剥离 HTML 注释（引导模板/用户自己写的注释），供注入 prompt 用；同时收敛多余空行。
export function stripUserMemoryComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
