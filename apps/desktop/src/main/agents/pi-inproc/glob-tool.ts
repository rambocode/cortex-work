// glob 工具(模型侧,参照 deepseek-harness tool-fs-search 的 glob 契约移植):按 glob 模式
// 发现文件路径,mtime 逆序(最新在前),含隐藏与被 ignore 文件、只排 VCS 元数据目录。
// 执行体在 pi-host worker 内直接 execFile 打包的 rg(纯 argv 无 shell、--no-config,
// 引擎与安全细节复用 ipc/fs-search-core.ts —— 该文件零 electron 依赖,worker 可安全 import)。
//
// 超限语义(与参照实现一致):≤100 条完整返回;超限时按**顶层目录轮询采样**取 100 条
// (每个顶层项先各得一席,不让单个子树占满整页),footer 明说采样方式,完整排序结果
// spill 到 os.tmpdir 下的文件并报告路径 —— 模型可用自己的 read 工具取回全量。
// rg 二进制路径由主进程 preparePiOpenRequest 解析后随 open 参数注入(worker 的模块解析
// 环境跨 dev/asar 不可靠,主进程解析一次是唯一权威)。
import { tmpdir } from "os";
import { join } from "path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  FsSearchError,
  parseFileList,
  runRg,
  sampleAcrossTopLevel,
  saveSpillFile,
  vcsExcludeGlobs,
  type TopLevelSample,
} from "../../ipc/fs-search-core";

/** 工具名(plan 档白名单 PI_PLAN_TOOL_WHITELIST 引用同一字面,两处一致)。 */
export const GLOB_TOOL_NAME = "glob";

/** 内联返回的路径数上限(对齐参照实现/Claude Code 的 GlobTool 默认)。 */
export const GLOB_MAX_RESULTS = 100;

/** 全量解析上限(远超内联上限,spill 全量也要有界,防病态 pattern 灌爆内存)。 */
export const GLOB_PARSE_CAP = 50_000;

/** worker 侧 glob spill 目录(模型经 read 工具取回,不需要进 fs 白名单)。 */
export function globSpillDir(): string {
  return join(tmpdir(), "cortex-glob-results");
}

// 系统提示词/工具描述按仓库规则一律英文(受众是模型)。
const GLOB_DESCRIPTION =
  "Find files whose paths match a glob pattern. Returns matching file paths — never directories — " +
  "including hidden and ignored files (VCS metadata directories are excluded). " +
  `Up to ${GLOB_MAX_RESULTS} paths come back newest-first by modification time; a larger result instead returns ` +
  `${GLOB_MAX_RESULTS} paths sampled across top-level entries, says so, and reports where the complete sorted ` +
  "list was saved. Prefer this over `find` or shell commands when discovering files by path pattern. " +
  "This tool does not enumerate directory entries.";

const GLOB_PARAMS: ToolDefinition["parameters"] = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description:
        'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). ' +
        'A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; ' +
        "include a separator to anchor the depth.",
    },
    path: {
      type: "string",
      description: "Directory to search in. Defaults to the session workspace; a relative path resolves against it.",
    },
  },
  required: ["pattern"],
};

/** glob 调用的 rg argv(导出供单测):--no-ignore 连被 ignore 的文件一起发现。 */
export function buildGlobArgs(pattern: string, path?: string): string[] {
  return [
    "--files",
    `--glob=${pattern}`,
    "--sortr=modified",
    "--no-ignore",
    "--hidden",
    ...vcsExcludeGlobs(),
    ...(path !== undefined ? ["--", path] : []),
  ];
}

/**
 * 超限结果的模型文本(导出供单测):采样页 + 采样说明 + 全量恢复路径。
 * 扁平结果(每条路径自成顶层项)退化为「取头部」,basis 用句号收尾(与参照实现一致)。
 */
export function formatGlobOverCap(
  sample: TopLevelSample<string>,
  seen: number,
  spillPath: string | undefined,
): string {
  const basis =
    sample.total === seen
      ? "."
      : `, sampled across ${sample.shown} of the ${sample.total} top-level entries this pattern matched instead of taken in modification-time order.` +
        (sample.shown < sample.total ? " Narrow path to inspect a specific subtree." : "");
  const recovery =
    spillPath !== undefined
      ? `Full sorted result stored at: ${spillPath}. Read that file to inspect every path.`
      : "The complete result could not be saved; narrow pattern or path to see more.";
  return `${sample.items.join("\n")}\n\n(Showing ${sample.items.length} of ${seen} paths${basis} ${recovery})`;
}

/**
 * 创建 glob 工具。cwd = 会话工作目录(检索根),rgPath = 主进程解析好的二进制路径。
 * maxResults 仅测试注入。
 */
export function createGlobTool(cwd: string, rgPath: string, maxResults = GLOB_MAX_RESULTS): ToolDefinition {
  return {
    name: GLOB_TOOL_NAME,
    label: "Glob",
    description: GLOB_DESCRIPTION,
    parameters: GLOB_PARAMS,
    async execute(_toolCallId, params, signal) {
      const p = (params ?? {}) as { pattern?: unknown; path?: unknown };
      // 错误一律 throw(0.82.1 丢弃 isError 字段,见 native-hooks.ts 文件头)。
      const pattern = typeof p.pattern === "string" ? p.pattern : "";
      if (!pattern.trim()) throw new Error("Error: pattern must be a non-empty string");
      const path = typeof p.path === "string" ? p.path : undefined;
      if (path !== undefined && !path.trim()) throw new Error("Error: path must be a non-empty string when given");

      let run;
      try {
        run = await runRg(buildGlobArgs(pattern, path), cwd, GLOB_TOOL_NAME, {
          rgPath,
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        // 分类码进消息头,模型可按类自纠偏(INVALID_PATTERN → 改 pattern;OVERFLOW → 收窄)。
        if (err instanceof FsSearchError) throw new Error(`Error [${err.code}]: ${err.message}`);
        throw new Error(`Error: glob failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const asResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
      if (run.noMatches) return asResult("No files found");
      const { paths } = parseFileList(run.stdout, GLOB_PARSE_CAP);
      if (paths.length === 0) return asResult("No files found");
      // 未超限:完整原样返回 —— mtime 逆序本身就是工具契约,回答「最近改了什么」。
      if (paths.length <= maxResults) return asResult(paths.join("\n"));
      const sample = sampleAcrossTopLevel(paths, (x) => x, maxResults);
      const spillPath = await saveSpillFile(globSpillDir(), "glob", paths.join("\n"));
      return asResult(formatGlobOverCap(sample, paths.length, spillPath));
    },
  };
}
