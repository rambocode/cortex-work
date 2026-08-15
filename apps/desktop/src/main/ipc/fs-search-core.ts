// 文件检索引擎(参照 deepseek-harness tool-fs-search 移植):ripgrep 后端替代 JS 递归扫描,
// 服务 fs.ts 的三个入口 —— fs:scanDirTree(文件树)、fs:searchContent(内容搜索)、
// buildFileIndex(basename → 路径解析)。
// 移植的关键设计:
//   ① 纯 argv、无 shell 层:模型/用户输入直接作 argv 元素,搜索词经 --regexp= 传递、
//      检索根置于 `--` 之后,杜绝前导连字符被解析成 flag;`--no-config` 挡掉宿主
//      RIPGREP_CONFIG_PATH 注入 --pre 任意执行的口子。
//   ② VCS 排除用成对 glob:`!**/.git` 剪枝遍历 + `!**/.git/**` 兜住「检索根就在 .git 里」。
//   ③ mtime 契约:--sortr=modified,最近改动的文件排最前(截断时最相关的存活)。
//   ④ 超限即报错:stdout 超 maxBuffer 抛 OUTPUT_OVERFLOW,绝不静默解析半截流。
//   ⑤ 错误分类词汇表:INVALID_PATTERN / SEARCH_FAILED / OUTPUT_OVERFLOW / ABORTED,
//      机器可路由,UI 可按类提示。
//   ⑥ 超限截断:顶层目录轮询采样(sampleAcrossTopLevel)替代取头部;完整结果落 spill
//      文件供「查看完整结果」恢复(best-effort,存失败不影响主结果)。
// ⚠️ 本文件必须保持**零 electron 依赖**:pi-host worker 里的 glob 工具(agents/pi-inproc/
// glob-tool.ts)直接 import 它,worker 的 electron 模块是抛错 stub。electron 相关的 spill
// 目录定位在薄壳 fs-search.ts 里(它 re-export 本文件供主进程消费)。
import { execFile } from "child_process";
import { promises as fsp } from "fs";
import { join, sep } from "path";
import type { ContentMatchFile, ContentMatchLine } from "./types";

// ── 常量(与 fs.ts 旧实现的口径对齐,来源见各注释) ────────────────────────────

/** 内容搜索命中文件上限(超出走采样 + spill)。 */
export const SEARCH_MAX_FILES = 200;
/** 每文件命中行上限(rg --max-count,精确对应旧 SEARCH_MAX_LINES_PER_FILE)。 */
export const SEARCH_MAX_LINES_PER_FILE = 5;
/** 单命中行展示字符上限。 */
export const MATCH_LINE_MAX_CHARS = 400;
/** rg 原始 stdout 上限(对齐参照实现/Claude Code 的 20MB;超限报错而非截断)。 */
export const RAW_OUTPUT_MAX_BYTES = 20_000_000;
/** 单次检索超时(参照实现的 cooperative timeout)。 */
export const SEARCH_TIMEOUT_MS = 30_000;
/** basename 索引的路径数上限(远高于旧 MAX_NODES=5000,深层文件也能被 @ 引用解析到)。 */
export const FILE_INDEX_MAX_PATHS = 20_000;
/** spill 目录保留的历史结果文件数。 */
const SPILL_KEEP_FILES = 20;

/**
 * VCS 元数据目录:任何检索都不进。必须成对生成两条负 glob(见 excludeGlobs)。
 */
export const VCS_EXCLUDES: readonly string[] = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

/**
 * 重型生成目录:非 git 根(写作空间等,无 .gitignore 可依)下防止 node_modules 之类
 * 拖垮检索;git 根下它们通常本来就被 .gitignore 覆盖,重复排除无害。
 */
export const HEAVY_DIR_EXCLUDES: readonly string[] = ["node_modules", "dist", "out", ".next", ".turbo"];

// ── 错误分类(⑤) ─────────────────────────────────────────────────────────────

/** 检索失败的稳定分类码。 */
export type FsSearchErrorCode = "INVALID_PATTERN" | "SEARCH_FAILED" | "OUTPUT_OVERFLOW" | "ABORTED";

/** 带分类码的检索错误(消息给人看,code 给程序路由)。 */
export class FsSearchError extends Error {
  readonly code: FsSearchErrorCode;
  constructor(message: string, code: FsSearchErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "FsSearchError";
    this.code = code;
  }
}

// ── argv 构造(①②③,纯函数供单测) ─────────────────────────────────────────

/** 名字列表 → 成对负 glob:裸形态剪枝遍历,`/**` 形态兜根在目录内的场景。 */
function pairedExcludeGlobs(names: readonly string[]): string[] {
  return names.flatMap((name) => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]);
}

/** 全部排除目录(VCS + 重型生成目录)的成对负 glob,UI 检索(树/内容搜索/索引)用。 */
export function excludeGlobs(): string[] {
  return pairedExcludeGlobs([...VCS_EXCLUDES, ...HEAVY_DIR_EXCLUDES]);
}

/**
 * 仅 VCS 元数据的成对负 glob:模型侧 glob 工具用(参照 deepseek-harness 的契约,
 * 工具走 --no-ignore 连被 ignore 的文件一起发现,只有 VCS 元数据永不进结果)。
 */
export function vcsExcludeGlobs(): string[] {
  return pairedExcludeGlobs(VCS_EXCLUDES);
}

/** 文件清单 argv(rg --files):含隐藏文件,尊重 .gitignore,最近修改在前。 */
export function buildFileListArgs(): string[] {
  return ["--files", "--hidden", "--sortr=modified", ...excludeGlobs()];
}

/**
 * 内容搜索 argv:固定字符串、大小写不敏感、JSON 输出逐行事件。
 * 搜索词经 --regexp= 传递(--fixed-strings 下按字面匹配),前导 `-` 不会被吃成 flag。
 */
export function buildContentSearchArgs(query: string): string[] {
  return [
    "--json",
    "--fixed-strings",
    "--ignore-case",
    "--hidden",
    "--sortr=modified",
    `--max-count=${SEARCH_MAX_LINES_PER_FILE}`,
    ...excludeGlobs(),
    `--regexp=${query}`,
    "--",
    ".",
  ];
}

// ── 二进制定位 ───────────────────────────────────────────────────────────────

let cachedRgPath: string | undefined;

/**
 * 解析打包的 ripgrep 二进制路径。不 import `@vscode/ripgrep` 的 JS(纯 ESM 包,
 * 主进程 CJS chunk require 它不可靠)——按其平台子包约定直接 require.resolve 二进制,
 * 与该包 index.js 的解析逻辑逐字对齐。打包态路径落在 asar 内时改写到 app.asar.unpacked
 * (electron-builder.yml 已把平台子包整体 unpack;asar 虚拟路径不可 exec)。
 */
export function resolveRgPath(): string {
  if (cachedRgPath !== undefined) return cachedRgPath;
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
  const platformPkg = `@vscode/ripgrep-${process.platform}-${process.arch}`;
  let resolved: string;
  try {
    resolved = require.resolve(`${platformPkg}/bin/${binaryName}`);
  } catch (error) {
    throw new FsSearchError(
      `ripgrep binary unavailable (${platformPkg})`,
      "SEARCH_FAILED",
      { cause: error },
    );
  }
  cachedRgPath = resolved.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  return cachedRgPath;
}

// ── 执行与错误分类(④⑤) ────────────────────────────────────────────────────

interface ExecFileError extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

/**
 * execFile 失败对象 → 分类错误(导出供单测)。退出码语义归工具所有:
 * 0 有结果,1 无结果(不是错误),2+ 才是失败;maxBuffer 超限与超时/信号单列。
 */
export function classifyExecError(toolName: string, err: ExecFileError, stderr: string): FsSearchError {
  if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new FsSearchError(
      `${toolName} produced more than ${RAW_OUTPUT_MAX_BYTES} bytes of output; narrow the query or path`,
      "OUTPUT_OVERFLOW",
    );
  }
  if (err.killed || err.signal || err.code === "ABORT_ERR" || err.name === "AbortError") {
    return new FsSearchError(`${toolName} was aborted (timeout or cancellation)`, "ABORTED");
  }
  const tail = stderr.trim().slice(0, 500);
  if (/regex parse error|error parsing glob/i.test(tail)) {
    return new FsSearchError(`${toolName} pattern rejected by ripgrep: ${tail}`, "INVALID_PATTERN");
  }
  const exit = typeof err.code === "number" ? ` (exit ${err.code})` : "";
  return new FsSearchError(
    `${toolName} search failed${exit}${tail ? `: ${tail}` : ""}`,
    "SEARCH_FAILED",
    { cause: err },
  );
}

/** 一次 rg 运行的完整获取:全量 stdout + 零结果标记。 */
export interface RgRun {
  stdout: string;
  noMatches: boolean;
}

/** runRg 可选项:rgPath 覆盖(worker 由主进程注入路径)与协作取消信号。 */
export interface RunRgOptions {
  rgPath?: string;
  signal?: AbortSignal;
}

/**
 * 跑打包的 rg:纯 argv(无 shell),恒前置 --no-config(①)。exit 1 = 成功零结果。
 */
export function runRg(
  argv: readonly string[],
  cwd: string,
  toolName = "search",
  opts: RunRgOptions = {},
): Promise<RgRun> {
  const rgPath = opts.rgPath ?? resolveRgPath();
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      rgPath,
      ["--no-config", ...argv],
      {
        cwd,
        timeout: SEARCH_TIMEOUT_MS,
        maxBuffer: RAW_OUTPUT_MAX_BYTES,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolvePromise({ stdout: stdout ?? "", noMatches: false });
          return;
        }
        const e = err as ExecFileError;
        if (e.code === 1 && !e.killed && !e.signal) {
          resolvePromise({ stdout: "", noMatches: true });
          return;
        }
        rejectPromise(classifyExecError(toolName, e, stderr ?? ""));
      },
    );
  });
}

// ── 输出解析(纯函数供单测) ────────────────────────────────────────────────

/** rg --files 输出 → 相对路径数组(保持 rg 的 mtime 逆序),超 cap 截断,归一 ./ 前缀。 */
export function parseFileList(stdout: string, cap: number): { paths: string[]; total: number } {
  const all = stdout.split("\n").filter((line) => line.length > 0);
  return { paths: all.slice(0, cap).map((p) => stripDotPrefix(p)), total: all.length };
}

/** 剥掉 rg 显式路径参数带来的 `./`(或 Windows `.\`)前缀,归一成干净相对路径。 */
function stripDotPrefix(rel: string): string {
  return rel.startsWith("./") || rel.startsWith(".\\") ? rel.slice(2) : rel;
}

/**
 * rg --json 输出 → 命中文件列表(文件顺序 = rg 输出顺序 = 最近修改在前;
 * 行内顺序 = 文件内行号序)。行文本 trimEnd + 字符截断,与旧 matchLines 口径一致。
 * 内容搜索显式传 `--` `.` 作检索根(execFile 下 stdin 是管道,不传路径 rg 会误读 stdin),
 * 由此产生的 `./` 前缀在这里剥掉。
 */
export function parseContentMatches(stdout: string, root: string): ContentMatchFile[] {
  const byPath = new Map<string, ContentMatchLine[]>();
  const order: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // 非 JSON 行(理论不出现):跳过,不让单行坏数据废掉整次搜索
    }
    const ev = event as { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
    if (ev.type !== "match") continue;
    const rawRel = ev.data?.path?.text;
    const text = ev.data?.lines?.text;
    const lineNumber = ev.data?.line_number;
    if (typeof rawRel !== "string" || typeof text !== "string" || typeof lineNumber !== "number") continue;
    const rel = stripDotPrefix(rawRel);
    let lines = byPath.get(rel);
    if (lines === undefined) {
      lines = [];
      byPath.set(rel, lines);
      order.push(rel);
    }
    lines.push({ line: lineNumber, text: text.trimEnd().slice(0, MATCH_LINE_MAX_CHARS) });
  }
  return order.map((rel) => {
    const name = rel.split(/[/\\]/).pop() ?? rel;
    return { path: join(root, rel), rel, name, lines: byPath.get(rel) ?? [] };
  });
}

// ── 顶层目录轮询采样(⑥,参照 sampleAcrossTopLevel 逐语义移植) ────────────────

/** 采样结果:入选项 + 触达的顶层项数 / 全量顶层项数。 */
export interface TopLevelSample<T> {
  items: T[];
  shown: number;
  total: number;
}

/** 相对路径的首段 = 顶层项;无分隔符的文件自成一组。 */
export function topLevelSegment(relPath: string): string {
  const cut = relPath.search(/[/\\]/);
  return cut === -1 ? relPath : relPath.slice(0, cut);
}

/**
 * 超限结果按顶层项轮询采样而非取头部:每个顶层目录先各得一席,再轮第二席,
 * 组间与组内均保持原序(原序 = mtime 逆序),故扁平结果退化为「取头部」。
 */
export function sampleAcrossTopLevel<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  maxItems: number,
): TopLevelSample<T> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = topLevelSegment(keyOf(item));
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  const taken = new Map<string, T[]>();
  let count = 0;
  let round = 0;
  while (count < maxItems) {
    let advanced = false;
    for (const [key, group] of groups) {
      if (count >= maxItems) break;
      const item = group[round];
      if (item === undefined) continue;
      advanced = true;
      const bucket = taken.get(key);
      if (bucket === undefined) taken.set(key, [item]);
      else bucket.push(item);
      count += 1;
    }
    if (!advanced) break;
    round += 1;
  }
  return { items: [...taken.values()].flat(), shown: taken.size, total: groups.size };
}

// ── spill:完整结果落盘(⑥,best-effort) ───────────────────────────────────

/**
 * 把完整搜索结果写入指定目录的 spill 文件,返回绝对路径;任何失败返回 undefined ——
 * 存储问题绝不把成功的搜索变成失败(参照 trySaveFormattedResult 的 best-effort 语义)。
 * 顺手修剪旧文件,只留最近 SPILL_KEEP_FILES 份。目录由调用方给:主进程用
 * Documents/cortex/.search-results(白名单内可预览),worker 的 glob 工具用 os.tmpdir 子目录。
 */
export async function saveSpillFile(dir: string, baseName: string, content: string): Promise<string | undefined> {
  try {
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    const path = join(dir, `${baseName}-${stamp}.txt`);
    await fsp.writeFile(path, content, "utf8");
    // 修剪:按名字排序(内嵌时间戳,字典序即时间序),删掉最旧的溢出份额。
    const entries = (await fsp.readdir(dir)).filter((n) => n.endsWith(".txt")).sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - SPILL_KEEP_FILES))) {
      await fsp.rm(join(dir, stale), { force: true });
    }
    return path;
  } catch {
    return undefined;
  }
}

/** 完整内容搜索结果的 spill 文本(纯文本,每文件一段:相对路径 + 行号:行文本)。 */
export function formatContentSpill(query: string, files: readonly ContentMatchFile[]): string {
  const head = `# Content search: ${query}\n# ${files.length} files with matches (newest first)\n`;
  const body = files
    .map((f) => [f.rel, ...f.lines.map((ln) => `  ${ln.line}: ${ln.text}`)].join("\n"))
    .join("\n\n");
  return `${head}\n${body}\n`;
}

// ── 文件树构建(fs:scanDirTree 消费) ────────────────────────────────────────

/** 与 ipc/types.ts 的 PromptNode 同形(此处本地声明避免循环依赖噪音)。 */
export interface TreeNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  children?: TreeNode[];
}

/**
 * 相对路径清单 → 嵌套目录树。文件来自 rg --files(尊重 .gitignore),
 * extraDirs 是补充的空目录(rg 只列文件,新建的空文件夹会丢,见 findEmptyDirs)。
 * 每层排序:目录在前,再按名称(与旧 scanTree 的 UI 排序一致;mtime 契约留给搜索/索引,
 * 树是浏览视图,字典序才可预期)。
 */
export function buildTreeFromPaths(
  rootPath: string,
  rootName: string,
  relFiles: readonly string[],
  extraDirs: readonly string[] = [],
): TreeNode {
  const root: TreeNode = { name: rootName, path: rootPath, kind: "dir", children: [] };
  const dirNodes = new Map<string, TreeNode>([["", root]]);

  const ensureDir = (relDir: string): TreeNode => {
    const existing = dirNodes.get(relDir);
    if (existing !== undefined) return existing;
    const cut = relDir.search(/[/\\][^/\\]*$/);
    const parent = ensureDir(cut === -1 ? "" : relDir.slice(0, cut));
    const name = cut === -1 ? relDir : relDir.slice(cut + 1);
    const node: TreeNode = { name, path: join(rootPath, relDir), kind: "dir", children: [] };
    parent.children!.push(node);
    dirNodes.set(relDir, node);
    return node;
  };

  for (const rel of relFiles) {
    const cut = rel.search(/[/\\][^/\\]*$/);
    const parent = ensureDir(cut === -1 ? "" : rel.slice(0, cut));
    const name = cut === -1 ? rel : rel.slice(cut + 1);
    parent.children!.push({ name, path: join(rootPath, rel), kind: "file" });
  }
  for (const relDir of extraDirs) ensureDir(relDir);

  const sortChildren = (node: TreeNode): void => {
    if (!node.children) return;
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of node.children) sortChildren(child);
  };
  sortChildren(root);
  return root;
}

/** 空目录发现的深度上限(补充扫描是廉价的 dirs-only 遍历,仍设防线)。 */
const EMPTY_DIR_MAX_DEPTH = 8;

const EXCLUDED_DIR_NAMES = new Set([...VCS_EXCLUDES, ...HEAVY_DIR_EXCLUDES]);

/**
 * 找出根下的全部**真空目录**(readdir 为零项),返回相对路径。rg --files 只列文件,
 * 新建的空文件夹会从树里消失(写作空间实测依赖「新建文件夹立即可见」),故补一次
 * dirs-only 遍历。只收真空目录:内容全被 ignore 的目录(如 coverage/)刻意不收——
 * 展示一个点开为空的目录比不展示更误导。
 */
export async function findEmptyDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > EMPTY_DIR_MAX_DEPTH) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.length === 0) {
      if (rel !== "") out.push(rel);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      await walk(join(dir, entry.name), rel === "" ? entry.name : `${rel}${sep}${entry.name}`, depth + 1);
    }
  };
  await walk(root, "", 0);
  return out;
}
