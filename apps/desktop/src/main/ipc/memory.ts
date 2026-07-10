// 用户记忆 IPC 域：渲染端读写三分区记忆 + 触发/查询做梦整理。
// 通道命名与 preload personal.memory* / DesktopBridge 的 memory* 方法一一对应
// （注册风格仿 ipc/reply.ts：单例收口 + 一个 registerXxxHandlers）。
// Dreamer 由 index.ts 注入（需要模型解析 + LLM 直连闭包 + mainWindow 推送,与 reply
// relearnHandler 的注入模式一致）;未注入时 dreamNow 返回 unavailable。

import { ipcMain, shell } from "electron";
import { promises as fsp } from "fs";
import type {
  DreamStateSummary,
  MemoryDreamResult,
  UserMemoryFile,
  UserMemoryScope,
} from "@cortex-work/core/memory/memory";
import { UserMemoryStore } from "../memory/memory-store";
import { DreamStateStore } from "../memory/dream-state";
import type { Dreamer } from "../memory/dreamer";
import { userMemoryDir, userMemoryDreamStatePath } from "../paths";
import { createLogger } from "../log";

const log = createLogger("memory-ipc");

// 记忆存储单例：ipc handler（读/写/清）与 index.ts 的做梦管线共用（main 唯一写者）。
export const userMemoryStore = new UserMemoryStore({
  memoryDir: userMemoryDir,
  logger: log,
});

// 做梦水位/历史存储单例：Dreamer 推进,getDreamState 读取。
export const dreamStateStore = new DreamStateStore({
  statePath: userMemoryDreamStatePath,
  logger: log,
});

let dreamer: Dreamer | null = null;

/// 注入做梦编排器（index.ts 建好 LLM 直连依赖后调用）。
export function setMemoryDreamer(instance: Dreamer): void {
  dreamer = instance;
}

/// 注册用户记忆 IPC 域。
export function registerMemoryHandlers(): void {
  // 读全部分区（每次现读 md 文件,Finder 编辑即时生效）。
  ipcMain.handle("memory:get", () => userMemoryStore.getMemory());

  // 写单分区手写区/自动区（设置页编辑）。
  ipcMain.handle(
    "memory:setFile",
    (_e, scope: UserMemoryScope, patch: Partial<UserMemoryFile>): Promise<void> =>
      userMemoryStore.setFile(scope, patch),
  );

  // 清空记忆：all=手写+自动；auto=仅自动整理要点。
  ipcMain.handle("memory:clear", (_e, kind: "all" | "auto"): Promise<void> =>
    kind === "auto" ? userMemoryStore.clearAuto() : userMemoryStore.clearAll(),
  );

  // 手动「立即整理」：转注入的 Dreamer（单飞,进行中返回 in-flight）。
  ipcMain.handle(
    "memory:dreamNow",
    (): Promise<MemoryDreamResult> =>
      dreamer ? dreamer.dreamNow("manual") : Promise.resolve({ ok: false, error: "unavailable" }),
  );

  // 做梦状态摘要（上次整理时间 + 最近历史,设置页展示）。
  ipcMain.handle("memory:getDreamState", async (): Promise<DreamStateSummary> => {
    const state = await dreamStateStore.load();
    return { lastDreamAt: state.lastDreamAt, history: state.history };
  });

  // 在 Finder 显示记忆文件夹（三个 md + dream-state.json,供用户直接查看/编辑/备份）。
  // 首次点击时目录可能还不存在,先 mkdir 兜底再打开。
  ipcMain.handle("memory:openFolder", async (): Promise<void> => {
    await fsp.mkdir(userMemoryDir(), { recursive: true });
    await shell.openPath(userMemoryDir());
  });

  // 启动物化：三个分区文件启动即存在（引导模板）,数据目录对用户自解释。
  void userMemoryStore.ensureMaterialized();
}
