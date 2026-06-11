// 个人工作区 fs IPC：目录选择、prompt 树扫描、md 读写。
// 安全约束：read/write 仅允许落在已注册的 promptRoot 或某个 project.path 之内。

import { dialog, ipcMain } from "electron";
import { promises as fsp } from "fs";
import { join, resolve, sep } from "path";
import { execFile } from "child_process";
import type { PromptNode } from "./types";
import { getPersistedState } from "./store";

const MAX_DEPTH = 8;
const MAX_NODES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "out", ".next", ".turbo"]);

function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

// 路径必须在 promptRoot 或某个项目目录内，否则拒绝。
async function assertAllowed(path: string): Promise<void> {
  const state = await getPersistedState();
  const roots = [state.promptRoot, ...state.projects.map((p) => p.path)].filter((r): r is string => !!r);
  if (!roots.some((root) => isInside(root, path))) {
    throw new Error(`路径不在允许范围内: ${path}`);
  }
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
      // 空目录不展示。
      if (child.children && child.children.length > 0) {
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

export function registerFsHandlers(): void {
  ipcMain.handle("fs:pickDirectory", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
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

  ipcMain.handle("fs:readFile", async (_e, path: string) => {
    await assertAllowed(path);
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

  ipcMain.handle("fs:writeFile", async (_e, path: string, content: string) => {
    await assertAllowed(path);
    await fsp.writeFile(path, content, "utf8");
  });

  ipcMain.handle("fs:validateDir", async (_e, path: string) => {
    try {
      return (await fsp.stat(path)).isDirectory();
    } catch {
      return false;
    }
  });
}
