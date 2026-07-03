// 记忆 markdown 文件格式的纯逻辑层（借鉴 Reply.app 的 memory 目录形态,KTD6 二次修订）：
// 每个分区一个 .md 文件,用户可直接在 Finder 编辑——
//   - 「## ⟨auto⟩」标记行**上方**是手写区（manual,优先级最高）,**下方**是自动学习区（auto）;
//   - 文件头的 HTML 注释是引导模板,组装 prompt 时经 stripMemoryComments 剥离,不进模型;
//   - parse/render 严格往返：设置页/蒸馏写回不破坏用户在文件里手写的任何内容（含注释）。
// 文件系统读写在 main 侧 memory-store.ts,此处只管文本格式。

import type { MemoryFile, MemoryScope } from "./memory";

/// 自动学习区标记行。parse 按「## ⟨auto⟩」前缀识别（兼容源项目带说明后缀的完整标题行）,
/// render 恒写这一行完整形态。
export const AUTO_MARKER = "## ⟨auto⟩ 从你最近发出的消息学到的（手写内容在上方，优先级更高）";

/// 标记行识别前缀（源项目文件可能只有前缀或带不同说明后缀）。
const AUTO_MARKER_PREFIX = "## ⟨auto⟩";

/// 解析 .md 全文为 {manual, auto}：标记行上方 manual、下方 auto,双侧裁剪首尾空白;
/// 无标记行时全文归 manual（手动创建的纯笔记文件也能读）。
export function parseMemoryMarkdown(text: string): MemoryFile {
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

/// 渲染 {manual, auto} 为 .md 全文。auto 为空也写标记行——用户打开文件即见分区结构,
/// 也保证 parse/render 往返稳定。
export function renderMemoryMarkdown(file: MemoryFile): string {
  const manual = file.manual.trim();
  const auto = file.auto.trim();
  const head = manual.length > 0 ? `${manual}\n\n` : "";
  const tail = auto.length > 0 ? `\n${auto}\n` : "\n";
  return `${head}${AUTO_MARKER}\n${tail}`;
}

// 各分区的引导模板（仿源项目文件头注释,全部为 HTML 注释——组装 prompt 时被剥离）。
const SCOPE_TEMPLATES: Record<MemoryScope, string> = {
  profile: `<!--
Profile — 关于「你是谁」的事实,所有渠道通用（角色/公司/在做的事/关键的人）。
在这条注释下面写,注释本身不会进 prompt。
-->`,
  core: `<!--
Core — 所有渠道通用的核心写法（句长、语气、用词习惯、中英混用等）。
在这条注释下面写,注释本身不会进 prompt。
-->`,
  im: `<!--
IM — 在 IM 里回复的形态规则（短、随意、是否用称呼/署名/emoji）,不重复 Core。
在这条注释下面写,注释本身不会进 prompt。
-->`,
  email: `<!--
Email — 邮件场景的形态规则（称呼、署名、分段、正式程度）。
在这条注释下面写,注释本身不会进 prompt。
-->`,
  publicVoice: `<!--
Public — 公开平台发言的形态规则（面向受众、简洁有观点）。
在这条注释下面写,注释本身不会进 prompt。
-->`,
};

/// 分区新文件的初始内容：引导注释 + 空自动区（manual 仅注释,剥离后为空,不污染 prompt）。
export function memoryFileTemplate(scope: MemoryScope): string {
  return renderMemoryMarkdown({ manual: SCOPE_TEMPLATES[scope], auto: "" });
}

/// 剥离 HTML 注释（引导模板/用户自己写的注释）,供 prompt 组装用;同时收敛多余空行。
export function stripMemoryComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
