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

export function registerChatHandlers(): void {
  ipcMain.handle("chat:load", async (_e, sessionId: string) => {
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
  });

  ipcMain.handle("chat:save", (_e, sessionId: string, messages: unknown[], branchGroups?: unknown[]) => {
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
  });

  ipcMain.handle("chat:delete", (_e, sessionId: string) => {
    const path = chatPath(sessionId); // 复用 SAFE_ID 校验
    // 同队列串行：删消息文件 + 该会话图片/文档目录（避免与在途 save / image:save / doc:save 交错留孤儿）。
    return enqueue(sessionId, async () => {
      try {
        await ensureMigrated();
        await fsp.rm(path, { force: true }); // 不存在不报错
        await fsp.rm(chatImagesDir(sessionId), { recursive: true, force: true });
        await fsp.rm(chatDocsDir(sessionId), { recursive: true, force: true });
        await fsp.rm(chatBranchesDir(sessionId), { recursive: true, force: true }); // 分支回复的 pi 会话快照

      } catch (err) {
        log.error("delete failed:", err);
      }
    });
  });
}
