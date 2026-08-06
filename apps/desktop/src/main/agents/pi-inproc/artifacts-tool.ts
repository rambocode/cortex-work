// artifacts 工具（pi-web-ui 移植,参考 @mariozechner/pi-web-ui 的 artifacts.ts,命令语义与错误
// 文案对齐上游以便模型自纠偏;`logs` 命令不做——它需要 HTML iframe console 回程,v2 可借 jsrepl 通道）。
//
// ── 执行形态:worker 内存态 + 事件流（方案「路线 A」）─────────────────────────────────
// execute 在 worker 内闭包 Map 上同步完成全部命令,不落盘、不回程渲染进程。每次成功变更把
// **应用变更后的全量快照**放进 `AgentToolResult.details`（0.82.1 的 agent-loop 会把 details 原样
// 放进 tool_execution_end.result,且 details 不进模型上下文——contract 测试锁死这条依赖）,
// 再由 `rpc-shared.ts` 的 mapPiEvent 特判转成 `PiSessionEvent{type:"artifact"}` 流向渲染层。
//
// ⚠️ 契约:update/rewrite 的 details 必须带全量 content（渲染层不做字符串替换,增量补丁在
// 部分重放/乱序下会静默腐化产物,见 core/desktop/types.ts 的 artifact 事件注释）。
//
// ── 生命周期（注释钉死,勿改语义）────────────────────────────────────────────────────
// 闭包 Map 的寿命 = createArtifactsTool() 一次调用 = 一个 UI 会话的 deps。`fork/switchSession/
// newSession` 只换 AgentSession、**不重建 deps**（session.ts 的 createRuntime 闭包捕获同一批
// customTools）,故产物跨 pi 子会话存续,与渲染端 UI 会话生命周期一致;`pi:open` 重开才清空。
// 这不是 bug:后来者不要在 fork 时「顺手」清 Map。

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** 工具名。与 packages/core/desktop/types.ts 的 ARTIFACTS_TOOL_NAME 字面一致（worker 不 import core）。 */
export const ARTIFACTS_TOOL_NAME = "artifacts";

/** 单个产物 content 上限（1MB）。超限直接 throw 可读错误,防止事件流与 trace 被灌爆。 */
export const ARTIFACT_MAX_CONTENT_BYTES = 1024 * 1024;

/**
 * filename 白名单:纯 basename（字母数字下划线点横线空格）,不含路径分隔与 `..`,不以 `.` 开头。
 * v1 不落盘也要校验——将来 UI 做「下载产物」时文件名就是现成的穿越向量,闸门必须现在装上。
 */
const FILENAME_RE = /^[\w.\- ]+$/;

/** mapPiEvent 从 tool_execution_end.result.details 里取的产物快照形状。 */
export interface ArtifactDetails {
  artifact: {
    action: "create" | "update" | "delete";
    filename: string;
    /** create/update 为应用变更后的全量内容;delete 无。 */
    content?: string;
  };
}

// 裸 JSON Schema + 集中 cast 的理由见 native-hooks.ts 文件头（typebox 是纯 ESM phantom 依赖）。
const ARTIFACTS_PARAMS: ToolDefinition["parameters"] = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["create", "update", "rewrite", "get", "delete"],
      description: "操作类型",
    },
    filename: { type: "string", description: "产物文件名(纯文件名,不含路径)" },
    content: { type: "string", description: "文件内容(create/rewrite 用)" },
    old_str: { type: "string", description: "待替换的原文片段(update 用,必须唯一命中)" },
    new_str: { type: "string", description: "替换后的新文本(update 用)" },
  },
  required: ["command", "filename"],
};

const ARTIFACTS_DESCRIPTION = `创建并维护与会话共存的可视产物文件(在用户侧栏实时渲染)。

## 何时使用
- 撰写供用户阅读的 markdown 笔记/分析/文档
- 构建自包含的 HTML 可视化/小应用(图表、仪表盘、交互演示)
- 生成 SVG 图形

## 命令
- { command: "create", filename: "notes.md", content: "..." } — 新建文件
- { command: "update", filename: "notes.md", old_str: "...", new_str: "..." } — 局部修改(优先)
- { command: "rewrite", filename: "notes.md", content: "..." } — 整文件重写(最后手段)
- { command: "get", filename: "app.html" } — 取回当前内容
- { command: "delete", filename: "old.md" } — 删除

## 支持的类型
✅ 自己撰写的文本文件: .md .txt .html .css .js .json .csv .svg
❌ 二进制文件(.pdf .docx 等)不支持

## HTML 产物要求
- 自包含单文件;可用 <script src="https://cdn.tailwindcss.com"></script> 或从 https://esm.sh 引 ES 模块
- 运行在沙箱 iframe:无 Node、无 localStorage/sessionStorage,可以 fetch(仅 https)
- 必须显式设置背景色(避免透明)

## 重要
- 小改动一律用 update(old_str → new_str),不要 get 全文再 rewrite
- update 的 old_str 必须能唯一定位;未命中会返回全文供重新定位`;

/** 会话内产物状态。仅在 worker 进程存在,渲染端经 artifact 事件维护同构副本。 */
interface ArtifactRecord {
  filename: string;
  content: string;
}

/** 校验 filename,不合法直接 throw（0.82.1 只认抛异常,见 native-hooks.ts 文件头）。 */
function assertFilename(filename: unknown): asserts filename is string {
  if (typeof filename !== "string" || !filename.trim()) throw new Error("Error: filename is required");
  if (!FILENAME_RE.test(filename) || filename.includes("..") || filename.startsWith(".")) {
    throw new Error(`Error: Invalid filename "${filename}". Use a plain basename like "notes.md"`);
  }
}

/** 校验 content 尺寸（按 UTF-8 字节数）。 */
function assertContentSize(content: string): void {
  if (Buffer.byteLength(content, "utf8") > ARTIFACT_MAX_CONTENT_BYTES) {
    throw new Error(`Error: content exceeds ${ARTIFACT_MAX_CONTENT_BYTES / 1024 / 1024}MB limit`);
  }
}

/** 「文件不存在」的可纠偏错误:附上现有文件列表,帮模型改对 filename 而不是盲目重试。 */
function notFoundError(files: Map<string, ArtifactRecord>, filename: string): Error {
  const names = [...files.keys()];
  if (!names.length) return new Error(`Error: File ${filename} not found. No files have been created yet.`);
  return new Error(`Error: File ${filename} not found. Available files: ${names.join(", ")}`);
}

/** 带产物快照的成功结果（mapPiEvent 靠 details.artifact 派生 artifact 事件）。 */
function artifactResult(
  text: string,
  artifact: ArtifactDetails["artifact"],
): { content: [{ type: "text"; text: string }]; details: ArtifactDetails } {
  return { content: [{ type: "text", text }], details: { artifact } };
}

/** 纯文本结果（get / 无状态变更路径,不产生 artifact 事件）。 */
function plainResult(text: string): { content: [{ type: "text"; text: string }]; details: undefined } {
  return { content: [{ type: "text", text }], details: undefined };
}

/**
 * 创建 artifacts 工具。每个 UI 会话调用一次（capabilities.ts 按 enableArtifactsTool 注册）,
 * 闭包 Map 即该会话的产物全量状态（生命周期语义见文件头,勿在 fork 时清空）。
 */
export function createArtifactsTool(): ToolDefinition {
  const files = new Map<string, ArtifactRecord>();

  return {
    name: ARTIFACTS_TOOL_NAME,
    label: "产物",
    description: ARTIFACTS_DESCRIPTION,
    parameters: ARTIFACTS_PARAMS,
    async execute(_toolCallId, params) {
      const p = (params ?? {}) as {
        command?: unknown;
        filename?: unknown;
        content?: unknown;
        old_str?: unknown;
        new_str?: unknown;
      };
      const command = String(p.command ?? "");
      assertFilename(p.filename);
      const filename = p.filename;

      switch (command) {
        case "create": {
          if (typeof p.content !== "string") throw new Error("Error: create command requires filename and content");
          if (files.has(filename)) throw new Error(`Error: File ${filename} already exists`);
          assertContentSize(p.content);
          files.set(filename, { filename, content: p.content });
          return artifactResult(`Created ${filename}`, { action: "create", filename, content: p.content });
        }
        case "update": {
          const rec = files.get(filename);
          if (!rec) throw notFoundError(files, filename);
          if (typeof p.old_str !== "string" || !p.old_str || typeof p.new_str !== "string") {
            throw new Error("Error: update command requires old_str and new_str");
          }
          if (!rec.content.includes(p.old_str)) {
            // 未命中回全文（上游同款）:让模型基于真实现状重新定位,而不是带着同样的 old_str 重试。
            throw new Error(`Error: String not found in file. Here is the full content:\n\n${rec.content}`);
          }
          const next = rec.content.replace(p.old_str, p.new_str);
          assertContentSize(next);
          rec.content = next;
          // ⚠️ details 带的是替换后的**全量**内容（契约见文件头）。
          return artifactResult(`Updated ${filename}`, { action: "update", filename, content: next });
        }
        case "rewrite": {
          const rec = files.get(filename);
          if (!rec) throw notFoundError(files, filename);
          if (typeof p.content !== "string") throw new Error("Error: rewrite command requires content");
          assertContentSize(p.content);
          rec.content = p.content;
          return artifactResult(`Rewrote ${filename}`, { action: "update", filename, content: p.content });
        }
        case "get": {
          const rec = files.get(filename);
          if (!rec) throw notFoundError(files, filename);
          return plainResult(rec.content);
        }
        case "delete": {
          if (!files.has(filename)) throw notFoundError(files, filename);
          files.delete(filename);
          return artifactResult(`Deleted ${filename}`, { action: "delete", filename });
        }
        default:
          throw new Error(`Error: Unknown command ${command}`);
      }
    },
  };
}
