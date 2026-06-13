// 编辑器检测 IPC：探测已安装的代码编辑器，并用 open -a 在指定编辑器中打开路径。
// 仅 darwin 实现（扫 /Applications 与 ~/Applications 下的已知 .app）；其他平台空表。
// 探测/打开纯靠 fs 与 child_process；electron 仅用于 ipcMain 注册，
// 测试只 import 纯函数（detectEditors/detectCached），无需 mock electron。

import { ipcMain } from "electron";
import { promises as fsp } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { assertAllowed } from "./fs";
import type { EditorInfo } from "./types";

// 候选编辑器清单（按常见度排序）。apps 为 .app 包名候选（任一命中即可，兼容多版本包名）。
interface EditorCandidate {
  id: string;
  name: string;
  apps: string[];
}

const CANDIDATES: EditorCandidate[] = [
  { id: "vscode", name: "Visual Studio Code", apps: ["Visual Studio Code.app"] },
  { id: "cursor", name: "Cursor", apps: ["Cursor.app"] },
  { id: "windsurf", name: "Windsurf", apps: ["Windsurf.app"] },
  { id: "zed", name: "Zed", apps: ["Zed.app"] },
  { id: "sublime", name: "Sublime Text", apps: ["Sublime Text.app"] },
  { id: "webstorm", name: "WebStorm", apps: ["WebStorm.app"] },
  { id: "intellij", name: "IntelliJ IDEA", apps: ["IntelliJ IDEA.app", "IntelliJ IDEA CE.app"] },
  { id: "xcode", name: "Xcode", apps: ["Xcode.app"] },
];

// 扫描目录（darwin）。
function editorDirs(): string[] {
  return ["/Applications", join(homedir(), "Applications")];
}

// 默认存在性判断：fs.stat 命中即视为存在。
async function defaultExists(path: string): Promise<boolean> {
  try {
    await fsp.stat(path);
    return true;
  } catch {
    return false;
  }
}

// 纯函数：给定扫描目录与存在性判断，返回命中编辑器及其 .app 绝对路径。
// 注入 exists 便于测试；保持 CANDIDATES 顺序输出，同一编辑器取首个命中的包路径。
export async function detectEditors(
  dirs: string[],
  exists: (path: string) => Promise<boolean>,
): Promise<{ id: string; name: string; appPath: string }[]> {
  const hits: { id: string; name: string; appPath: string }[] = [];
  for (const candidate of CANDIDATES) {
    let appPath: string | undefined;
    for (const dir of dirs) {
      for (const app of candidate.apps) {
        const full = join(dir, app);
        if (await exists(full)) {
          appPath = full;
          break;
        }
      }
      if (appPath) break;
    }
    if (appPath) hits.push({ id: candidate.id, name: candidate.name, appPath });
  }
  return hits;
}

export const CACHE_TTL_MS = 60_000;
type EditorEntry = { id: string; name: string; appPath: string };
let cache: { at: number; entries: EditorEntry[] } | null = null;

// 带 60s TTL 缓存的探测（可注入 detect/now 以便测 TTL）：
// 非 darwin 直接返回空表，且不写缓存（平台无关、无需缓存）。
export async function detectCached(
  detect: () => Promise<EditorEntry[]> = () => detectEditors(editorDirs(), defaultExists),
  now: () => number = Date.now,
  platform: NodeJS.Platform = process.platform,
): Promise<EditorEntry[]> {
  if (platform !== "darwin") return [];
  const t = now();
  if (cache && t - cache.at < CACHE_TTL_MS) return cache.entries;
  const entries = await detect();
  cache = { at: t, entries };
  return entries;
}

// 仅供测试：清空模块级缓存。
export function resetEditorCache(): void {
  cache = null;
}

export function registerEditorHandlers(): void {
  // 列出已安装编辑器（仅暴露 id/name，不泄露 .app 路径给 renderer）。
  ipcMain.handle("shell:listEditors", async (): Promise<EditorInfo[]> => {
    const entries = await detectCached();
    return entries.map(({ id, name }) => ({ id, name }));
  });

  // 在指定编辑器中打开路径：路径过白名单 → 查回 .app 绝对路径 → open -a。
  ipcMain.handle("shell:openInEditor", async (_e, path: string, editorId: string): Promise<void> => {
    await assertAllowed(path);
    const entries = await detectCached();
    const target = entries.find((e) => e.id === editorId);
    if (!target) throw new Error(`未找到编辑器: ${editorId}`);
    await new Promise<void>((resolve, reject) => {
      execFile("open", ["-a", target.appPath, path], { timeout: 5000 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  });
}
