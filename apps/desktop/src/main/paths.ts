// 个人工作区数据目录：~/.cortex-desktop/
//   personal-workspace.json  项目/session 元数据
//   chats/<sessionId>.json   会话消息历史
//   notes.json               闪记元数据 + 正文
// 旧版本数据存于 Electron userData，启动后首次访问时自动迁移。

import { app } from "electron";
import { promises as fsp } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createLogger } from "./log";

const log = createLogger("paths");

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

// 分支回复的 pi 会话文件快照根:~/.cortex-desktop/chat-branches/（per-session 子目录,
// 随会话删除清理）。刷新重新生成前把当前 pi 会话 JSONL 复制到此,旧分支据快照 switchSession 续聊。
export function chatBranchesRoot(): string {
  return join(cortexHome(), "chat-branches");
}

export function chatBranchesDir(sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`非法 session id: ${sessionId}`);
  return join(chatBranchesRoot(), sessionId);
}

// 任务附件落盘根:~/.cortex-desktop/task-docs/（per-task 子目录，U13）。
// 复用聊天文档附件闸门（doc.ts saveDocInto/assertDocPath），仅换存储根。
// 专用根，**刻意不纳入** fs.ts 的 allowedRoots()（同 chat-docs）——因 assertOpenable 有
// 「任意真实文件即放行」兜底会击穿限制；读/删侧以此根经 assertDocPath 做严格边界。
export function taskDocsRoot(): string {
  return join(cortexHome(), "task-docs");
}

// 单任务附件目录:task-docs/<taskId>/。taskId 经 SAFE_SESSION_ID 校验防路径穿越
//（taskId 形如 task-<base36>-<seq>-<random>，字符集恒落在 [\w-] 内）。
export function taskDocsDir(taskId: string): string {
  if (!SAFE_SESSION_ID.test(taskId)) throw new Error(`非法 task id: ${taskId}`);
  return join(taskDocsRoot(), taskId);
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

// 真任务系统：单文件全量（main-owned，version 独立于 personal-workspace.json）。
export function tasksJsonPath(): string {
  return join(cortexHome(), "tasks.json");
}

// 消息中心：单文件全量（main-owned）。60 天过期 + 条数上限由 notification-center-store 裁剪，
// 故不会无限增长。与瞬态的通知卡片窗口（notification-window.ts）无关。
export function notificationsStorePath(): string {
  return join(cortexHome(), "notifications.json");
}

// 桌面宠物 pet-overlay 窗口的拖拽落点：单文件全量（main-owned，重启后恢复位置）。
export function petPositionPath(): string {
  return join(cortexHome(), "pet-position.json");
}

// petdex 公共宠物图鉴的本地缓存根：~/.cortex-desktop/petdex/
//   manifest.json          图鉴索引（瘦身后约 420KB，带 etag + fetchedAt）
//   sprites/<slug>.webp    原始 sprite 字节（不转码）
//   sprites/<slug>.json    该 sprite 的元信息（尺寸/网格/etag/最近使用时刻）
// 离线兜底靠它：宠物是常驻 overlay，没网时不能变白板。
export function petdexDir(): string {
  return join(cortexHome(), "petdex");
}

export function petdexManifestPath(): string {
  return join(petdexDir(), "manifest.json");
}

export function petdexSpritesDir(): string {
  return join(petdexDir(), "sprites");
}

// 自动化执行历史：按 automationId 一文件（automation-runs/<id>.json）。
export function automationRunsDir(): string {
  return join(cortexHome(), "automation-runs");
}

// 工作流配置：单文件全量（workflows.json）。
export function workflowsStorePath(): string {
  return join(cortexHome(), "workflows.json");
}

// 工作流执行历史：按 workflowId 一文件（workflow-runs/<id>.json）。
export function workflowRunsDir(): string {
  return join(cortexHome(), "workflow-runs");
}

// 快捷回复助手数据目录：~/.cortex-desktop/reply/（main-owned，借鉴源项目 ReplyClone
// 把记忆/历史落应用数据目录的形态；KTD6/KTD8 修订见 reply/history-store.ts 头注）。
export function replyDataDir(): string {
  return join(cortexHome(), "reply");
}

// 回复历史：events/<bundleId>__<appName>/<id>.json,每事件一文件按应用分目录
//（借鉴 Reply.app 形态,见 reply/history-store.ts）。
export function replyEventsDir(): string {
  return join(replyDataDir(), "events");
}

// 【遗留迁移源】上一版单文件回复历史;ensureMaterialized 拆分为 events 后改名 .migrated。
export function replyHistoryPath(): string {
  return join(replyDataDir(), "history.json");
}

// 对话级记忆：单文件全量（按 app+联系人 key 索引，LRU 淘汰）。
export function replyConversationMemoryPath(): string {
  return join(replyDataDir(), "conversation-memory.json");
}

// 全局 5 分区记忆：memory/profile/profile.md + memory/voice/*.md,每分区一个 markdown
//（借鉴 Reply.app 形态,用户可 Finder 直接编辑,见 reply/memory-store.ts）。
export function replyMemoryDir(): string {
  return join(replyDataDir(), "memory");
}

// 【遗留迁移源】上一版单文件记忆;ensureMaterialized 拆分为 md 后改名 .migrated。
export function replyMemoryPath(): string {
  return join(replyDataDir(), "memory.json");
}

// 用户记忆（跨会话/写作/设计共享的语义记忆）目录：~/.cortex-desktop/memory/，
// 每分区一个 markdown（profile/preferences/projects.md,用户可 Finder 直接编辑,
// 见 memory/memory-store.ts）。与 reply 域的 replyMemoryDir 互相独立。
export function userMemoryDir(): string {
  return join(cortexHome(), "memory");
}

// 做梦整理的水位与历史：memory/dream-state.json（main-owned,见 memory/dream-state.ts）。
export function userMemoryDreamStatePath(): string {
  return join(userMemoryDir(), "dream-state.json");
}

// ---------------------------------------------------------------------------
// Cortex Research Engine（CRE）本地存储（spec §13.1）
// ---------------------------------------------------------------------------

// CRE 存储根：~/.cortex-desktop/research/
//   research.sqlite   Session / 计划 / 证据元数据（正文不在其中）
//   blobs/            正文按 <sha256>.gz 落盘（blob-store.ts）
//   browser-policy/   Research Browser 的 action policy JSON（KTD7）
//   tmp/              仅限临时文件,启动时清理超 24 小时且不属于 active operation 的残留
//
// **对 spec 的刻意偏离**：spec 写的是 `<userData>/research/`,这里落在 cortexHome() 下,
// 与个人工作区其余数据同根,避免用户数据散落两处（本仓库既有全部存储都已迁到 ~/.cortex-desktop）。
// 两者同样位于 asar 之外的受控位置,§19.5 的打包要求不受影响。
export function researchDir(): string {
  return join(cortexHome(), "research");
}

// SQLite 主库路径。node:sqlite 只在 main/research/sqlite-driver.ts 一处动态 import。
export function researchDbPath(): string {
  return join(researchDir(), "research.sqlite");
}

// 正文 blob 目录。**必须与 researchTmpDir 同卷**：blob 写入是 tmp 落盘 + rename 就位,
// 跨卷 rename 会退化成复制,原子性丢失（见 blob-store.ts 的 writeAtomic）。
export function researchBlobsDir(): string {
  return join(researchDir(), "blobs");
}

// 临时文件目录。除此之外任何位置都不得写研究中间产物（spec §13.1）。
export function researchTmpDir(): string {
  return join(researchDir(), "tmp");
}

// Research Browser 的 action policy 落盘目录（KTD7 + U0 spike S4a：
// agent-browser 对畸形/缺失 policy 是 fail-open 的,适配器必须自检探针后才可继续）。
export function researchBrowserPolicyDir(): string {
  return join(researchDir(), "browser-policy");
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
    log.error("数据迁移失败:", err);
  });
  return migrated;
}
