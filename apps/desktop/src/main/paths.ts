// 个人工作区数据目录：~/.cortex-desktop/
//   personal-workspace.json  项目/session 元数据
//   chats/<sessionId>.json   会话消息历史
//   notes.json               闪记元数据 + 正文
// 旧版本数据存于 Electron userData，启动后首次访问时自动迁移。

import { app } from "electron";
import { promises as fsp } from "fs";
import { homedir } from "os";
import { join } from "path";

export function cortexHome(): string {
  return join(homedir(), ".cortex-desktop");
}

export function workspaceStorePath(): string {
  return join(cortexHome(), "personal-workspace.json");
}

export function chatsDir(): string {
  return join(cortexHome(), "chats");
}

// 聊天图片落盘根:~/.cortex-desktop/chat-images/（per-session 子目录,随会话删除清理）。
export function chatImagesRoot(): string {
  return join(cortexHome(), "chat-images");
}

const SAFE_SESSION_ID = /^[\w-]+$/;

// 单会话图片目录:chat-images/<sessionId>/。sessionId 经 SAFE_ID 校验防路径穿越
//（image:save / chat:delete 的 recursive 删除都依赖该校验）。
export function chatImagesDir(sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`非法 session id: ${sessionId}`);
  return join(chatImagesRoot(), sessionId);
}

// 聊天文档附件落盘根:~/.cortex-desktop/chat-docs/（per-session 子目录,随会话删除清理）。
// 专用根,**不**纳入 fs.ts 的 allowedRoots()——抽取工具(doc-extract)读取时以此根做严格边界,
// 杜绝 assertOpenable「任意真实文件即放行」兜底被用来读任意路径(见 doc.ts assertDocPath)。
export function chatDocsRoot(): string {
  return join(cortexHome(), "chat-docs");
}

export function chatDocsDir(sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`非法 session id: ${sessionId}`);
  return join(chatDocsRoot(), sessionId);
}

export function timelinesDir(): string {
  return join(cortexHome(), "timelines");
}

// 主进程文件日志目录：~/.cortex-desktop/logs/
export function logsDir(): string {
  return join(cortexHome(), "logs");
}

// 不使用项目的会话归档根目录：用户「文稿」下的 cortex。
export function documentsCortexDir(): string {
  return join(app.getPath("documents"), "cortex");
}

// 不使用项目的会话工作目录：documentsCortexDir/<YYYY-MM-DD>，按日期归档。
export function noProjectSessionDir(dayKey: string): string {
  return join(documentsCortexDir(), dayKey);
}

// 自动化（定时任务）配置：单文件全量。
export function automationsStorePath(): string {
  return join(cortexHome(), "automations.json");
}

// 闪记：单文件全量（元数据 + 正文内联）。
export function notesStorePath(): string {
  return join(cortexHome(), "notes.json");
}

// 自动化执行历史：按 automationId 一文件（automation-runs/<id>.json）。
export function automationRunsDir(): string {
  return join(cortexHome(), "automation-runs");
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

let migrated: Promise<void> | null = null;

// 幂等迁移：新位置缺失且旧位置存在时搬运（rename 同卷快速路径,失败回退复制）。
export function ensureMigrated(): Promise<void> {
  migrated ??= (async () => {
    await fsp.mkdir(cortexHome(), { recursive: true });

    const oldStore = join(app.getPath("userData"), "personal-workspace.json");
    if (!(await exists(workspaceStorePath())) && (await exists(oldStore))) {
      try {
        await fsp.rename(oldStore, workspaceStorePath());
      } catch {
        await fsp.copyFile(oldStore, workspaceStorePath());
      }
    }

    const oldChats = join(app.getPath("userData"), "personal-chats");
    if (!(await exists(chatsDir())) && (await exists(oldChats))) {
      try {
        await fsp.rename(oldChats, chatsDir());
      } catch {
        await fsp.mkdir(chatsDir(), { recursive: true });
        for (const f of await fsp.readdir(oldChats)) {
          await fsp.copyFile(join(oldChats, f), join(chatsDir(), f));
        }
      }
    }
  })().catch((err) => {
    console.error("[cortex-desktop] 数据迁移失败:", err);
  });
  return migrated;
}
