// 个人工作区会话消息持久化：~/.cortex-desktop/chats/<sessionId>.json。
// 消息结构对主进程不透明（core 的 Message 类型），按 unknown[] 读写。

import { ipcMain } from "electron";
import { promises as fsp } from "fs";
import { join } from "path";
import { chatDocsDir, chatImagesDir, chatsDir, ensureMigrated } from "../paths";
import { enqueue } from "./sessionWriteQueue";

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
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return []; // 首次或文件不存在
    }
  });

  ipcMain.handle("chat:save", (_e, sessionId: string, messages: unknown[]) => {
    const path = chatPath(sessionId);
    // 经共享 sessionWriteQueue 串行（与 chat:delete / image:save 同会话互斥）。
    // 写失败吞掉并记日志，保持既有「保存尽力而为、不向 renderer 抛」的行为。
    return enqueue(sessionId, async () => {
      try {
        await ensureMigrated();
        await fsp.mkdir(chatDir(), { recursive: true });
        const tmp = path + ".tmp";
        await fsp.writeFile(tmp, JSON.stringify(messages), "utf8");
        await fsp.rename(tmp, path);
      } catch (err) {
        console.error("[personal-chats] save failed:", err);
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
      } catch (err) {
        console.error("[personal-chats] delete failed:", err);
      }
    });
  });
}
