// 全局 5 分区记忆存储核心（不依赖 electron）的单测：首启迁移旧分片、字段级兜底、
// 分区写入、清空（全部/仅 auto）、损坏隔离。electron 绑定层（ipc/reply.ts）人工验证。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { emptyMemoryState, type MemoryState } from "@cortex-work/core/reply/memory";
import { ReplyMemoryStore, type ReplyMemoryStoreDeps } from "./memory-store";

let dir: string;
let file: string;

function makeStore(overrides: Partial<ReplyMemoryStoreDeps> = {}): ReplyMemoryStore {
  return new ReplyMemoryStore({ storePath: () => file, ...overrides });
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), "reply-memory-"));
  file = join(dir, "memory.json");
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("ReplyMemoryStore", () => {
  it("文件缺失且无旧分片 → 全空分区", async () => {
    const memory = await makeStore().getMemory();
    expect(memory).toEqual(emptyMemoryState());
  });

  it("首启从旧分片搬运并落盘（loadLegacy 只调一次）", async () => {
    const legacy: MemoryState = {
      ...emptyMemoryState(),
      core: { manual: "简短", auto: "- 爱用语气词" },
    };
    const loadLegacy = vi.fn(async () => legacy);
    const store = makeStore({ loadLegacy });
    expect((await store.getMemory()).core.auto).toBe("- 爱用语气词");
    await store.getMemory();
    expect(loadLegacy).toHaveBeenCalledTimes(1);

    // 已落盘：新实例（不带 legacy）能直接读到
    expect((await makeStore().getMemory()).core.manual).toBe("简短");
  });

  it("旧分片半缺字段 → 字段级兜底为空串（下游 .trim() 安全）", async () => {
    const legacy = { core: { manual: "只有手写" } } as unknown as MemoryState;
    const memory = await makeStore({ loadLegacy: async () => legacy }).getMemory();
    expect(memory.core).toEqual({ manual: "只有手写", auto: "" });
    expect(memory.im).toEqual({ manual: "", auto: "" });
  });

  it("setFile 写单分区不动其它分区，磁盘往返一致", async () => {
    const store = makeStore();
    await store.setFile("im", { auto: "- 短句" });
    await store.setFile("im", { manual: "别用 emoji" });
    const memory = await makeStore().getMemory();
    expect(memory.im).toEqual({ manual: "别用 emoji", auto: "- 短句" });
    expect(memory.email).toEqual({ manual: "", auto: "" });
  });

  it("clearAuto 只清学习要点保留手写；clearAll 全清", async () => {
    const store = makeStore();
    await store.setFile("core", { manual: "手写", auto: "- 学到" });
    await store.clearAuto();
    expect((await store.getMemory()).core).toEqual({ manual: "手写", auto: "" });
    await store.setFile("core", { auto: "- 又学到" });
    await store.clearAll();
    expect(await store.getMemory()).toEqual(emptyMemoryState());
  });

  it("损坏文件 → 隔离 .corrupt 回空态（不回落旧分片，避免复活更旧数据）", async () => {
    await fsp.writeFile(file, "broken", "utf8");
    const loadLegacy = vi.fn(async () => ({
      ...emptyMemoryState(),
      core: { manual: "旧", auto: "" },
    }));
    const memory = await makeStore({ loadLegacy }).getMemory();
    expect(memory).toEqual(emptyMemoryState());
    expect(loadLegacy).not.toHaveBeenCalled();
    expect(await fsp.readFile(file + ".corrupt", "utf8")).toBe("broken");
  });
});
