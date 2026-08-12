// 个人工作区会话消息持久化：~/.cortex-desktop/chats/<sessionId>.json。
// 消息结构对主进程不透明（core 的 Message 类型），按 unknown[] 读写。

import { ipcMain } from "electron";
import { promises as fsp } from "fs";
import { join } from "path";
import { chatBranchesDir, chatDocsDir, chatImagesDir, chatsDir, ensureMigrated } from "../paths";
import { enqueue } from "./sessionWriteQueue";
import { createLogger } from "../log";
// 用户记忆「小睡」触发信号：每次会话落盘都视为一次活动,空闲一段时间后做梦增量整理
// （调度器未初始化时安全 no-op,见 memory/dream-scheduler.ts）。
import { noteMemoryActivity } from "../memory/dream-scheduler";

const log = createLogger("personal-chats");

const SAFE_ID = /^[\w-]+$/;

function chatDir(): string {
  return chatsDir();
}

function chatPath(sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) throw new Error(`非法 session id: ${sessionId}`);
  return join(chatDir(), `${sessionId}.json`);
}

// 工作过程归档单独一个文件:它是**可丢**数据(丢了只损失回顾,不损失对话),不能因为体积或
// 解析失败连累正文;正文文件也不该被每轮的工具输出撑大。渲染端契约见 core/personal/process-archive.ts。
function processPath(sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) throw new Error(`非法 session id: ${sessionId}`);
  return join(chatDir(), `${sessionId}.process.json`);
}

/** 读取一个会话的过程归档(数组);文件缺失/损坏一律按空归档处理,不向 renderer 抛。 */
export async function loadProcessArchive(sessionId: string): Promise<unknown> {
  await ensureMigrated();
  try {
    const raw = await fsp.readFile(processPath(sessionId), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 串行保存过程归档(与 chat:save / chat:delete 同队列,避免与删除交错留孤儿文件)。 */
export function saveProcessArchive(sessionId: string, turns: unknown[]): Promise<void> {
  const path = processPath(sessionId);
  return enqueue(sessionId, async () => {
    try {
      await ensureMigrated();
      await fsp.mkdir(chatDir(), { recursive: true });
      const tmp = path + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(turns), "utf8");
      await fsp.rename(tmp, path);
    } catch (err) {
      log.error("save process archive failed:", err);
    }
  });
}

/**
 * 读取一个已校验会话的消息文件。IPC 和受限的专用窗口共用此实现，避免两条存储路径漂移。
 */
export async function loadChat(sessionId: string): Promise<unknown> {
  await ensureMigrated();
  try {
    const raw = await fsp.readFile(chatPath(sessionId), "utf8");
    const parsed = JSON.parse(raw);
    // v1 裸数组 / v2 对象 {version:2, messages, branchGroups}(分支回复)都原样返回,
    // 渲染端 normalizeLoadedChat 归一;其它形状按空历史处理。
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { messages?: unknown }).messages)) return parsed;
    return [];
  } catch {
    return []; // 首次或文件不存在
  }
}

/**
 * 串行保存一个已校验会话的消息文件。写失败保持既有尽力而为语义，并记录到主进程日志。
 */
export function saveChat(sessionId: string, messages: unknown[], branchGroups?: unknown[]): Promise<void> {
  const path = chatPath(sessionId);
  // 经共享 sessionWriteQueue 串行（与 chat:delete / image:save 同会话互斥）。
  // 写失败吞掉并记日志，保持既有「保存尽力而为、不向 renderer 抛」的行为。
  return enqueue(sessionId, async () => {
    try {
      await ensureMigrated();
      await fsp.mkdir(chatDir(), { recursive: true });
      const tmp = path + ".tmp";
      // 有分支写 v2 对象(与 core/personal/branches.ts 的 ChatFileV2 契约一致),
      // 无分支维持 v1 裸数组——保证未用过分支功能的会话可被旧版本客户端读取(回滚安全)。
      const payload = branchGroups?.length ? { version: 2, messages, branchGroups } : messages;
      await fsp.writeFile(tmp, JSON.stringify(payload), "utf8");
      await fsp.rename(tmp, path);
      // 会话有新内容落盘 → 上报记忆活动（重置做梦「小睡」debounce 计时器）。
      noteMemoryActivity();
    } catch (err) {
      log.error("save failed:", err);
    }
  });
}

export function registerChatHandlers(): void {
  ipcMain.handle("chat:load", (_e, sessionId: string) => loadChat(sessionId));
  ipcMain.handle("chat:save", (_e, sessionId: string, messages: unknown[], branchGroups?: unknown[]) =>
    saveChat(sessionId, messages, branchGroups),
  );

  ipcMain.handle("chat:loadProcess", (_e, sessionId: string) => loadProcessArchive(sessionId));
  ipcMain.handle("chat:saveProcess", (_e, sessionId: string, turns: unknown[]) =>
    saveProcessArchive(sessionId, turns),
  );

  ipcMain.handle("chat:delete", (_e, sessionId: string) => {
    const path = chatPath(sessionId); // 复用 SAFE_ID 校验
    const procPath = processPath(sessionId);
    // 同队列串行：删消息文件 + 该会话图片/文档目录（避免与在途 save / image:save / doc:save 交错留孤儿）。
    return enqueue(sessionId, async () => {
      try {
        await ensureMigrated();
        await fsp.rm(path, { force: true }); // 不存在不报错
        await fsp.rm(procPath, { force: true }); // 过程归档随会话一起删,不留孤儿
        await fsp.rm(chatImagesDir(sessionId), { recursive: true, force: true });
        await fsp.rm(chatDocsDir(sessionId), { recursive: true, force: true });
        await fsp.rm(chatBranchesDir(sessionId), { recursive: true, force: true }); // 分支回复的 pi 会话快照

      } catch (err) {
        log.error("delete failed:", err);
      }
    });
  });
}
