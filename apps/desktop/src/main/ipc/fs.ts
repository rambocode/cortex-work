// 个人工作区 fs IPC：目录选择、prompt 树扫描、md 读写。
// 安全约束：read/write 仅允许落在已注册的 promptRoot 或某个 project.path 之内。

import { dialog, ipcMain, shell } from "electron";
import { promises as fsp } from "fs";
import { dirname, join, resolve, sep } from "path";
import { execFile } from "child_process";
import type {
  ContentMatchFile,
  ContentMatchLine,
  ContentSearchResult,
  GitBranchesResult,
  GitDiffAllResult,
  GitInfoResult,
  GitOpResult,
  PromptNode,
  WritingSaveImagePayload,
} from "./types";
import { getPersistedState } from "./store";
import { expandTilde } from "../skills/locate";
import { documentsCortexDir, noProjectSessionDir } from "../paths";
import { countAddedLines, parseNumstat, parseUntracked, sumStats, synthUntrackedDiff } from "./git-info";
import { readImageOpenable } from "./image";
import type { ImageReadResult } from "./types";

const MAX_DEPTH = 8;
const MAX_NODES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "out", ".next", ".turbo"]);

function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

// 会话级授权根:用户经系统目录选择器(fs:pickDirectory)明确选中的目录。选择本身即授权
// (Electron 常规安全模型)。持久化白名单(writingUi.spaces 等)由渲染端节流落盘,新添加的
// 空间根落盘前扫描会被拒(时序竞态)——本集合在选中时刻即时放行,重启后由持久化根接管。
const sessionPickedRoots = new Set<string>();

// 信任白名单:promptRoot + Documents/cortex/<日期>(无项目会话读写处) + 各项目根
// + 设计工作台根(自定义 defaultWorkspaceRoot 与各设计稿 workspaceRoot;默认根在
// Documents/cortex 下已被覆盖,这里只为用户自定义目录兜底。localHtml 预览授权同样
// 复用本白名单,故设计产物 HTML 的 webview 预览无需另开口子)。
async function allowedRoots(): Promise<string[]> {
  const state = await getPersistedState();
  return [
    state.promptRoot,
    documentsCortexDir(),
    ...state.projects.map((p) => p.path),
    state.designSettings?.defaultWorkspaceRoot,
    ...(state.designDocs ?? []).map((d) => d.workspaceRoot),
    // 写作工作区：默认根在 Documents/cortex/writing（已被上面覆盖），此处只为用户自定义空间根兜底放行。
    ...(state.writingUi?.spaces ?? []).map((s) => s.root),
    // 本次会话内用户经系统对话框选中的目录(见 sessionPickedRoots)。
    ...sessionPickedRoots,
  ].filter((r): r is string => !!r);
}

// 路径必须在白名单根内，否则拒绝。写/删等改动型操作及 watch.ts 等共用(严格)。
export async function assertAllowed(path: string): Promise<void> {
  const roots = await allowedRoots();
  if (!roots.some((root) => isInside(root, path))) {
    throw new Error(`路径不在允许范围内: ${path}`);
  }
}

// 「打开/读取」放宽校验:白名单根内 → 放行;否则仅当目标是真实存在的文件才放行。
// 用途:打开 agent 写到项目根之外的产物(如 outputs/ 落在项目外)。只读取与系统 open
// 用此,写/删仍走严格 assertAllowed,避免越权写入项目外。目录/不存在路径一律拒。
export async function assertOpenable(path: string): Promise<void> {
  const roots = await allowedRoots();
  if (roots.some((root) => isInside(root, path))) return;
  try {
    if ((await fsp.stat(path)).isFile()) return;
  } catch {
    /* 落到拒绝 */
  }
  throw new Error(`路径不在允许范围内: ${path}`);
}

async function scanTree(
  dir: string,
  name: string,
  depth: number,
  budget: { left: number },
  mdOnly = true,
): Promise<PromptNode> {
  const node: PromptNode = { name, path: dir, kind: "dir", children: [] };
  if (depth > MAX_DEPTH || budget.left <= 0) return node;

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return node;
  }
  entries.sort((a, b) => {
    // 目录在前，再按名称。
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (budget.left <= 0) break;
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const child = await scanTree(full, entry.name, depth + 1, budget, mdOnly);
      // mdOnly(提示词树):无 md 的目录是噪音,不展示。
      // 全量树(scanDirTree:文件视图/写作空间/design 列目录):空目录如实返回——
      // 否则新建文件夹在树里不可见;要不要隐藏由消费方决定(如写作侧 filterWritingTree)。
      if (!mdOnly || (child.children && child.children.length > 0)) {
        node.children!.push(child);
        budget.left -= 1;
      }
    } else if (entry.isFile() && (!mdOnly || entry.name.toLowerCase().endsWith(".md"))) {
      node.children!.push({ name: entry.name, path: full, kind: "file" });
      budget.left -= 1;
    }
  }
  return node;
}

function runGit(
  args: string[],
  cwd: string,
  maxBuffer = 4 * 1024 * 1024,
): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    // maxBuffer 超限时 err 非空但 stdout 仍有已收集部分,调用方可按 truncated 处理。
    // 第三参 stderr 供分支操作把 git 报错透出给 UI。
    execFile("git", args, { cwd, timeout: 5000, maxBuffer }, (e, stdout, stderr) =>
      resolve({ ok: !e, out: stdout ?? "", err: stderr ?? "" }),
    );
  });
}

// dayKey 形如 YYYY-MM-DD,严格校验防路径穿越（如 ../../etc）。
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 读 untracked 文件内容用于 ± 统计与合成 diff。
// text=正常文本 / binary=二进制(计 0 行) / skipped=过大或读取失败(统计标记 truncated)。
async function readUntracked(path: string): Promise<{ kind: "text"; content: string } | { kind: "binary" } | { kind: "skipped" }> {
  try {
    const stat = await fsp.stat(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { kind: "skipped" };
    const buf = await fsp.readFile(path);
    if (buf.subarray(0, 8000).includes(0)) return { kind: "binary" };
    return { kind: "text", content: buf.toString("utf8") };
  } catch {
    return { kind: "skipped" };
  }
}

const UNTRACKED_LIMIT = 200; // 防未 ignore 的海量文件(如 node_modules)拖垮主进程
const DIFF_ALL_SOFT_LIMIT = 1.5 * 1024 * 1024; // 拼接后总量软上限

// 会话文件链接定位:basename → 绝对路径列表 的项目级索引,带短 TTL。
// 一次消息渲染会对几十个文件链接批量探测,缓存让全项目只扫一次(见 fs:resolveProjectFile)。
const FILE_INDEX_TTL_MS = 15_000;
const fileIndexCache = new Map<string, { at: number; index: Map<string, string[]> }>();

async function buildFileIndex(root: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  const budget = { left: MAX_NODES };
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || budget.left <= 0) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (budget.left <= 0) break;
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        const arr = index.get(e.name);
        if (arr) arr.push(full);
        else index.set(e.name, [full]);
        budget.left -= 1;
      }
    }
  }
  await walk(root, 0);
  return index;
}

// 内容搜索（右侧「文件」视图 ? 前缀）限额：命中文件 / 每文件命中行 / 单行展示字符。
const SEARCH_MAX_FILES = 200;
const SEARCH_MAX_LINES_PER_FILE = 5;
const MATCH_LINE_MAX_CHARS = 400;

// 逐行大小写不敏感子串匹配（非正则,避免 ReDoS）。导出供单测。
export function matchLines(content: string, query: string, maxLines: number): ContentMatchLine[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: ContentMatchLine[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (out.length >= maxLines) break;
    const raw = lines[i];
    if (raw.toLowerCase().includes(q)) {
      out.push({ line: i + 1, text: raw.trimEnd().slice(0, MATCH_LINE_MAX_CHARS) });
    }
  }
  return out;
}

async function getFileIndex(root: string, now: number): Promise<Map<string, string[]>> {
  const hit = fileIndexCache.get(root);
  if (hit && now - hit.at < FILE_INDEX_TTL_MS) return hit.index;
  const index = await buildFileIndex(root);
  fileIndexCache.set(root, { at: now, index });
  return index;
}

// ── 写作工作区图片落盘(fs:writingSaveImage,U1)─────────────────────────────
// 与 Kun WORKSPACE_IMAGE_DIR 对齐:粘贴/生成图片统一落到空间根下的 img/ 子目录。
export const WRITING_IMAGE_DIR = "img";

// 落盘扩展名净化:去点、小写,只接受 1-8 位字母数字,否则回落 png。
// 防止渲染端把畸形 mime / 后缀塞进文件名造成路径异常或穿越。导出供单测。
export function normalizeWritingImageExt(ext: string): string {
  const cleaned = ext.trim().replace(/^\.+/, "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(cleaned) ? cleaned : "png";
}

// 首选图片文件名 pasted-<紧凑时间戳>-<短随机>.<ext>(rand 防同毫秒粘贴撞名)。now 注入便于测试。
// 导出供单测断言命名形状。
export function buildWritingImageName(ext: string, now: Date = new Date(), rand?: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const suffix = rand ?? Math.random().toString(36).slice(2, 8);
  return `pasted-${stamp}-${suffix}.${normalizeWritingImageExt(ext)}`;
}

// 目标已存在时按 <base>-1.<ext> / <base>-2.<ext> 递增找空位(粘贴撞名极少见,兜底不覆盖)。
// 用 stat 探测:ENOENT 即空位。上限防御性设 10000 次,超出直接返回最后候选。导出供单测。
export async function resolveNonCollidingPath(dir: string, fileName: string): Promise<string> {
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  let candidate = join(dir, fileName);
  for (let i = 1; i < 10000; i += 1) {
    try {
      await fsp.stat(candidate);
    } catch {
      return candidate; // 不存在 → 可用
    }
    candidate = join(dir, `${base}-${i}${ext}`);
  }
  return candidate;
}

export function registerFsHandlers(): void {
  ipcMain.handle("fs:pickDirectory", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    const picked = result.filePaths[0]!;
    // 用户经系统对话框选中即视为授权,即时纳入白名单——否则新空间根要等渲染端节流
    // 持久化落盘后才被 allowedRoots 认可,添加空间后的立即扫描会报「路径不在允许范围内」。
    sessionPickedRoots.add(picked);
    return picked;
  });

  ipcMain.handle("fs:scanPromptTree", async (_e, root: string) => {
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) throw new Error(`不是目录: ${root}`);
    const parts = root.replace(/[/\\]+$/, "").split(/[/\\]/);
    return scanTree(root, parts[parts.length - 1] || root, 0, { left: MAX_NODES });
  });

  // 项目目录全量文件树（不限 md;用于右侧「文件」视图）。
  ipcMain.handle("fs:scanDirTree", async (_e, root: string) => {
    await assertAllowed(root);
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) throw new Error(`不是目录: ${root}`);
    const parts = root.replace(/[/\\]+$/, "").split(/[/\\]/);
    return scanTree(root, parts[parts.length - 1] || root, 0, { left: MAX_NODES }, false);
  });

  // 项目内文件内容搜索（右侧「文件」视图 ? 前缀）。遍历同 scanTree 约束
  //（跳过 SKIP_DIRS / 隐藏文件,受 MAX_DEPTH / MAX_FILE_BYTES 限制）,逐行子串匹配。
  // 命中文件数 / 遍历文件总数达上限时置 truncated。
  ipcMain.handle("fs:searchContent", async (_e, root: string, query: string): Promise<ContentSearchResult> => {
    await assertAllowed(root);
    const q = query.trim();
    if (!q) return { files: [], truncated: false };
    const files: ContentMatchFile[] = [];
    const budget = { left: MAX_NODES };
    let truncated = false;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || budget.left <= 0 || files.length >= SEARCH_MAX_FILES) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (budget.left <= 0) {
          truncated = true;
          break;
        }
        if (files.length >= SEARCH_MAX_FILES) {
          truncated = true;
          break;
        }
        if (e.name.startsWith(".")) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          await walk(full, depth + 1);
        } else if (e.isFile()) {
          budget.left -= 1;
          try {
            const stat = await fsp.stat(full);
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
            const buf = await fsp.readFile(full);
            if (buf.subarray(0, 8000).includes(0)) continue; // 二进制:跳过
            const lines = matchLines(buf.toString("utf8"), q, SEARCH_MAX_LINES_PER_FILE);
            if (lines.length > 0) {
              files.push({ path: full, rel: full.slice(root.length + 1), name: e.name, lines });
            }
          } catch {
            /* 读取失败:跳过该文件 */
          }
        }
      }
    };
    await walk(root, 0);
    return { files, truncated };
  });

  // git 变更列表（最近变更视图）。非 git 仓库时回退按 mtime 的最近修改文件。
  ipcMain.handle("fs:gitChanges", async (_e, root: string) => {
    await assertAllowed(root);
    const gitResult = await new Promise<{ ok: boolean; out: string }>((resolve) => {
      execFile("git", ["status", "--porcelain"], { cwd: root, timeout: 5000 }, (err, stdout) =>
        resolve({ ok: !err, out: stdout ?? "" }),
      );
    });
    if (gitResult.ok) {
      const files = gitResult.out
        .split("\n")
        .filter(Boolean)
        .slice(0, 200)
        .map((line) => {
          const status = line.slice(0, 2).trim() || "M";
          // rename 形如 "R  old -> new",取新路径
          let rel = line.slice(3);
          const arrow = rel.indexOf(" -> ");
          if (arrow >= 0) rel = rel.slice(arrow + 4);
          return { path: join(root, rel.replace(/^"|"$/g, "")), rel: rel.replace(/^"|"$/g, ""), status };
        });
      return { isRepo: true, files };
    }
    // 非 git 仓库:扫描树取 mtime 最近的文件
    const tree = await scanTree(root, "root", 0, { left: MAX_NODES }, false);
    const flat: { path: string; rel: string; status: string; mtime: number }[] = [];
    const collect = async (n: PromptNode) => {
      if (n.kind === "file") {
        try {
          const st = await fsp.stat(n.path);
          flat.push({ path: n.path, rel: n.path.slice(root.length + 1), status: "M", mtime: st.mtimeMs });
        } catch {
          /* skip */
        }
      }
      for (const c of n.children ?? []) await collect(c);
    };
    await collect(tree);
    flat.sort((a, b) => b.mtime - a.mtime);
    return { isRepo: false, files: flat.slice(0, 30).map(({ path, rel, status }) => ({ path, rel, status })) };
  });

  // git 提交记录（项目时间线用）。非 git 仓库返回空数组。
  ipcMain.handle("fs:gitLog", async (_e, root: string, opts?: { sinceTs?: number; max?: number }) => {
    await assertAllowed(root);
    const max = Math.min(opts?.max ?? 300, 1000);
    const args = ["log", `--max-count=${max}`, "--pretty=format:%H%x09%ct%x09%s"];
    // @<epoch> 是 git 文档化的无歧义时间戳写法。
    if (opts?.sinceTs) args.push(`--since=@${Math.floor(opts.sinceTs / 1000)}`);
    return new Promise<{ ts: number; hash: string; subject: string }[]>((resolve) => {
      execFile("git", args, { cwd: root, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve([]);
        resolve(
          stdout
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [hash, ct, ...rest] = line.split("\t");
              return { hash, ts: Number(ct) * 1000, subject: rest.join("\t") };
            })
            .filter((c) => c.hash && Number.isFinite(c.ts)),
        );
      });
    });
  });

  // 单文件 git diff（untracked 文件由调用方回退到 readFile 预览）。
  ipcMain.handle("fs:gitDiff", async (_e, root: string, rel: string) => {
    await assertAllowed(root);
    return new Promise<string>((resolve) => {
      execFile("git", ["diff", "HEAD", "--", rel], { cwd: root, timeout: 5000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) =>
        resolve(err ? "" : stdout),
      );
    });
  });

  // GitBar:分支 + 工作区 ± 行数统计(含 untracked,与 commit 后 git show --stat 一致)。
  // 任一 git 命令失败(非仓库/超时)→ isRepo:false 静默降级,信息条隐藏。
  ipcMain.handle("fs:gitInfo", async (_e, root: string): Promise<GitInfoResult> => {
    await assertAllowed(root);
    const branchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], root);
    if (!branchRes.ok) return { isRepo: false, additions: 0, deletions: 0, dirty: false };
    let branch = branchRes.out.trim();
    if (branch === "HEAD") {
      // detached HEAD:退回 short SHA 展示
      const sha = await runGit(["rev-parse", "--short", "HEAD"], root);
      if (sha.ok) branch = sha.out.trim();
    }
    const [numstatRes, statusRes] = await Promise.all([
      runGit(["diff", "HEAD", "--numstat"], root),
      // -uall:展开 untracked 目录为逐文件,否则整个新目录只算一条
      runGit(["status", "--porcelain", "-uall"], root),
    ]);
    const tracked = numstatRes.ok ? parseNumstat(numstatRes.out) : [];
    const untracked = statusRes.ok ? parseUntracked(statusRes.out) : [];
    let truncated = !numstatRes.ok || !statusRes.ok || untracked.length > UNTRACKED_LIMIT;
    const counts: number[] = [];
    for (const rel of untracked.slice(0, UNTRACKED_LIMIT)) {
      const file = await readUntracked(join(root, rel));
      if (file.kind === "skipped") truncated = true;
      counts.push(file.kind === "text" ? countAddedLines(file.content) : 0);
    }
    const { additions, deletions } = sumStats(tracked, counts);
    const dirty = statusRes.ok && statusRes.out.trim().length > 0;
    return { isRepo: true, branch, additions, deletions, dirty, truncated };
  });

  // GitBar「查看 diff」:整仓 diff(tracked 真实 git diff + untracked 合成片段)。
  ipcMain.handle("fs:gitDiffAll", async (_e, root: string): Promise<GitDiffAllResult> => {
    await assertAllowed(root);
    const statusRes = await runGit(["status", "--porcelain", "-uall"], root);
    if (!statusRes.ok) return { diff: "", truncated: false };
    const trackedRes = await runGit(["diff", "HEAD"], root);
    // ok=false 但有 stdout 多半是 maxBuffer 超限,用已收集部分并标记截断
    let truncated = !trackedRes.ok && trackedRes.out.length > 0;
    const parts: string[] = trackedRes.out ? [trackedRes.out] : [];
    let total = trackedRes.out.length;
    const untracked = parseUntracked(statusRes.out);
    if (untracked.length > UNTRACKED_LIMIT) truncated = true;
    for (const rel of untracked.slice(0, UNTRACKED_LIMIT)) {
      if (total > DIFF_ALL_SOFT_LIMIT) {
        truncated = true;
        break;
      }
      const file = await readUntracked(join(root, rel));
      if (file.kind === "skipped") {
        truncated = true;
        continue;
      }
      const synth = synthUntrackedDiff(rel, file.kind === "text" ? file.content : null);
      parts.push(synth);
      total += synth.length;
    }
    return { diff: parts.join(""), truncated };
  });

  // 无项目会话工作目录:确保 Documents/cortex/<YYYY-MM-DD> 存在,返回绝对路径。
  // dayKey 经正则校验防路径穿越。
  ipcMain.handle("fs:ensureNoProjectDir", async (_e, dayKey: string): Promise<string> => {
    if (!DAY_KEY_RE.test(dayKey)) throw new Error(`非法日期键: ${dayKey}`);
    const dir = noProjectSessionDir(dayKey);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  });

  // GitBar 分支选择:本地分支列表 + 当前分支。任一 git 命令失败 → isRepo:false。
  ipcMain.handle("fs:gitBranches", async (_e, root: string): Promise<GitBranchesResult> => {
    await assertAllowed(root);
    const listRes = await runGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"], root);
    if (!listRes.ok) return { isRepo: false, branches: [], current: "" };
    const branches = listRes.out.split("\n").map((l) => l.trim()).filter(Boolean);
    const curRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], root);
    if (!curRes.ok) return { isRepo: false, branches: [], current: "" };
    return { isRepo: true, branches, current: curRes.out.trim() };
  });

  // GitBar 新建分支:git switch -c <name>(同时切到新分支)。
  ipcMain.handle("fs:gitCreateBranch", async (_e, root: string, name: string): Promise<GitOpResult> => {
    await assertAllowed(root);
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, message: "分支名不能为空" };
    const res = await runGit(["switch", "-c", trimmed], root);
    if (res.ok) return { ok: true };
    return { ok: false, message: res.err.trim() || res.out.trim() || "创建分支失败" };
  });

  // GitBar 切换分支:工作区有未提交改动时禁止切换并提示先提交。
  ipcMain.handle("fs:gitCheckout", async (_e, root: string, name: string): Promise<GitOpResult> => {
    await assertAllowed(root);
    const status = await runGit(["status", "--porcelain"], root);
    if (status.ok && status.out.trim().length > 0) {
      return { ok: false, message: "工作区有未提交改动，请先提交后再切换分支" };
    }
    const res = await runGit(["switch", name], root);
    if (res.ok) return { ok: true };
    return { ok: false, message: res.err.trim() || res.out.trim() || "切换分支失败" };
  });

  ipcMain.handle("fs:readFile", async (_e, path: string) => {
    await assertOpenable(path);
    const stat = await fsp.stat(path);
    if (stat.size > MAX_FILE_BYTES) {
      const fh = await fsp.open(path, "r");
      try {
        const buf = Buffer.alloc(MAX_FILE_BYTES);
        await fh.read(buf, 0, MAX_FILE_BYTES, 0);
        return { content: buf.toString("utf8"), truncated: true };
      } finally {
        await fh.close();
      }
    }
    return { content: await fsp.readFile(path, "utf8"), truncated: false };
  });

  // 会话消息里文件链接的「项目内」定位:把 ref(相对路径或裸文件名)解析为真实绝对路径。
  // 1) 先试精确路径——只要 ref 指向真实存在的文件即直接用(含项目根之外的 agent 产物,
  //    如 outputs/ 落在项目外;不再要求 isInside,否则项目外文件渲染成不可点击灰色文本);
  // 2) 否则按 basename 在项目内查找(yuque 导出等表格只列文件名,真实文件在子目录) → 取首个匹配;
  // 3) 仍找不到 → null。越权 / 出错一律 null,不抛错(避免污染主进程日志,见 chatMarkdown.tsx)。
  ipcMain.handle("fs:resolveProjectFile", async (_e, root: string, ref: string): Promise<string | null> => {
    try {
      await assertAllowed(root);
      const exact = ref.startsWith("/") ? ref : join(root, ref);
      try {
        if ((await fsp.stat(exact)).isFile()) return exact;
      } catch {
        /* 落到 basename 搜索 */
      }
      const base = exact.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? ref;
      const index = await getFileIndex(root, Date.now());
      const hits = index.get(base);
      return hits && hits.length > 0 ? hits[0] : null;
    } catch {
      return null;
    }
  });

  ipcMain.handle("fs:writeFile", async (_e, path: string, content: string) => {
    await assertAllowed(path);
    await fsp.mkdir(dirname(path), { recursive: true });
    await fsp.writeFile(path, content, "utf8");
  });

  ipcMain.handle("fs:deleteFile", async (_e, path: string) => {
    await assertAllowed(path);
    await fsp.rm(path, { force: true });
  });

  // 设计工作台(design)需要的目录能力:建目录 / 递归删除条目(文件或目录)。
  // 与其它 fs handler 一致走 assertAllowed 白名单;deleteEntry 是破坏性操作,只对白名单内路径生效。
  ipcMain.handle("fs:mkdir", async (_e, path: string) => {
    await assertAllowed(path);
    await fsp.mkdir(path, { recursive: true });
  });

  ipcMain.handle("fs:deleteEntry", async (_e, path: string) => {
    await assertAllowed(path);
    await fsp.rm(path, { recursive: true, force: true });
  });

  // 设计工作台默认根:Documents/cortex/design(天然在白名单内,零配置可用)。调用即确保存在。
  ipcMain.handle("fs:designWorkspaceRoot", async () => {
    const dir = join(documentsCortexDir(), "design");
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  });

  // 写作工作区默认根:Documents/cortex/writing(天然在白名单内,零配置可用)。调用即确保存在。
  // 仿 fs:designWorkspaceRoot;首次进入写作工作区时据此建立默认空间。
  ipcMain.handle("fs:writingWorkspaceRoot", async () => {
    const dir = join(documentsCortexDir(), "writing");
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  });

  // 写作工作区:粘贴/生成图片落盘(U1)。落 <spaceRoot>/img/pasted-<ts>-<rand>.<ext>,
  // 返回落盘绝对路径,渲染端据此换算相对当前 md 的链接插入正文。
  // 安全:img 目录与最终目标都过严格 assertAllowed(必须在已注册空间根内),越权即抛。
  // 重名递增(resolveNonCollidingPath)兜底不覆盖已有文件。
  ipcMain.handle("fs:writingSaveImage", async (_e, payload: WritingSaveImagePayload): Promise<string> => {
    const { spaceRoot, bytesBase64, ext } = payload;
    if (!spaceRoot?.trim()) throw new Error("缺少写作空间根");
    const buf = Buffer.from(bytesBase64 ?? "", "base64");
    if (!buf.length) throw new Error("图片数据为空");
    const imgDir = join(spaceRoot, WRITING_IMAGE_DIR);
    await assertAllowed(imgDir);
    await fsp.mkdir(imgDir, { recursive: true });
    const target = await resolveNonCollidingPath(imgDir, buildWritingImageName(ext));
    await assertAllowed(target);
    await fsp.writeFile(target, buf);
    return target;
  });

  // 写作工作区:重命名文件/目录(文件树重命名 + 空间内改名共用)。
  // 同目录重名预检:fs.rename 在 POSIX 下会静默覆盖已存在的目标,故先 stat 目标——
  // 已存在则拒绝、不覆盖,避免重命名把另一文件顶掉。from/to 均须在白名单内。
  ipcMain.handle("fs:renameEntry", async (_e, from: string, to: string) => {
    await assertAllowed(from);
    await assertAllowed(to);
    try {
      await fsp.stat(to);
      // stat 成功 = 目标已存在,拒绝重命名。
      throw new Error(`目标已存在: ${to}`);
    } catch (err) {
      // 仅在「目标不存在(ENOENT)」时放行;其余错误(含上面主动抛的重名错误)向上抛。
      if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err;
    }
    await fsp.mkdir(dirname(to), { recursive: true });
    await fsp.rename(from, to);
  });

  ipcMain.handle("fs:createTaskFile", async (_e, projectRoot: string, todoId: string, title: string) => {
    await assertAllowed(projectRoot);
    const taskDir = join(projectRoot, "tasks");
    const taskPath = join(taskDir, `${todoId}.md`);
    await assertAllowed(taskPath);
    await fsp.mkdir(taskDir, { recursive: true });
    const initial = `# ${title.trim() || "未命名 Todo"}\n\n## 背景\n\n## 实现要求\n\n## 验收\n`;
    try {
      await fsp.writeFile(taskPath, initial, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "EEXIST") throw err;
    }
    return taskPath;
  });

  // Tasks 面板:列出项目 tasks/ 与 tasks/archive/ 顶层 .md（带 mtime,
  // 供面板展示与按周期分组归档）。目录不存在返回空列表。
  ipcMain.handle("fs:listTaskFiles", async (_e, projectRoot: string) => {
    await assertAllowed(projectRoot);
    const listMd = async (dir: string) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const files: { name: string; path: string; mtimeMs: number }[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.toLowerCase().endsWith(".md")) continue;
        const full = join(dir, entry.name);
        try {
          files.push({ name: entry.name, path: full, mtimeMs: (await fsp.stat(full)).mtimeMs });
        } catch {
          /* 列举期间被删,跳过 */
        }
      }
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return files;
    };
    const taskDir = join(projectRoot, "tasks");
    return { files: await listMd(taskDir), archived: await listMd(join(taskDir, "archive")) };
  });

  // 校验目录存在性。须与 skill 根解析一致地展开 `~`（pluginSkillRoots 走 expandTilde),
  // 否则手填 `~/my/skills` 校验恒 false 而扫描却能命中,渲染端校验会误报。
  ipcMain.handle("fs:validateDir", async (_e, path: string) => {
    try {
      return (await fsp.stat(expandTilde(path))).isDirectory();
    } catch {
      return false;
    }
  });

  // 文件存在性探测（深化/生成 plan run 收尾判产出用:确定路径,绕开 changedFiles 截断）。
  // 仿 validateDir:stat + try/catch 返回布尔,不抛、不读内容。
  ipcMain.handle("fs:exists", async (_e, path: string) => {
    try {
      return (await fsp.stat(path)).isFile();
    } catch {
      return false;
    }
  });

  // 文件预览工具栏:用系统默认应用打开 / 在访达中显示。
  // openPath 放宽到 assertOpenable:支持打开 agent 写到项目外的产物(交 OS 处理,等同用户双击)。
  ipcMain.handle("shell:openPath", async (_e, path: string) => {
    await assertOpenable(path);
    const err = await shell.openPath(path);
    if (err) throw new Error(err);
  });

  ipcMain.handle("shell:revealInFolder", async (_e, path: string) => {
    await assertAllowed(path);
    shell.showItemInFolder(path);
  });

  // agent 产出本地图片回读为 dataURL,供聊天内联渲染(项目外绝对路径如 ~/.codex/generated_images,
  // 或项目内 .cortex/media/images)。闸门 = openPath 的 assertOpenable 宽松语义(白名单根内 OR 真实
  // 存在文件),叠加 readImageOpenable 的符号链接/realpath/仅位图扩展名/体积上限硬防护。
  ipcMain.handle(
    "image:readAny",
    (_e, path: string): Promise<ImageReadResult> =>
      readImageOpenable(path, (realTarget) => assertOpenable(realTarget).then(() => true, () => false)),
  );

  // Markdown 预览链接:仅放行 http/https,避免 file:// 等协议被滥用。
  ipcMain.handle("shell:openExternal", async (_e, url: string) => {
    const protocol = new URL(url).protocol;
    if (protocol !== "http:" && protocol !== "https:") {
      throw new Error(`不支持的链接协议: ${protocol}`);
    }
    await shell.openExternal(url);
  });
}
