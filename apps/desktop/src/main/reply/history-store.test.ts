// 回复历史存储核心（不依赖 electron）的单测：追加/读取往返、并发串行、
// 损坏文件隔离重建、清空、上限截断。electron 绑定层（ipc/reply.ts）人工验证。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fsp } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ReplyHistoryEntry } from "@cortex-work/core/reply/history";
import { ReplyHistoryStore, newReplyHistoryId } from "./history-store";

let dir: string;
let file: string;

function makeStore(keep?: number): ReplyHistoryStore {
  return new ReplyHistoryStore({ historyPath: () => file, keep });
}

/// 最小历史条目工厂。
function entry(id: string, ts: number): ReplyHistoryEntry {
  return {
    id,
    ts,
    appName: "WeChat",
    appBundleId: "com.tencent.xinWeChat",
    counterpart: "张玲玲",
    conversation: "对方：明天方便吗？",
    candidates: [{ text: "可以的", stance: null }],
    acceptedIndex: 0,
    acceptedText: "可以的",
  };
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), "reply-history-"));
  file = join(dir, "history.json");
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("ReplyHistoryStore", () => {
  it("追加后可读回，newest-first，磁盘往返一致", async () => {
    const store = makeStore();
    await store.append(entry("a", 1));
    await store.append(entry("b", 2));
    expect((await store.list()).map((e) => e.id)).toEqual(["b", "a"]);

    // 新实例从磁盘冷读，验证真实落盘
    const reread = makeStore();
    expect((await reread.list()).map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("并发追加串行化，全部保留", async () => {
    const store = makeStore();
    await Promise.all([store.append(entry("a", 1)), store.append(entry("b", 2)), store.append(entry("c", 3))]);
    expect(await store.count()).toBe(3);
  });

  it("超过 keep 上限时截断最旧的", async () => {
    const store = makeStore(2);
    await store.append(entry("a", 1));
    await store.append(entry("b", 2));
    await store.append(entry("c", 3));
    expect((await store.list()).map((e) => e.id)).toEqual(["c", "b"]);
  });

  it("文件缺失 → 空历史（不抛）", async () => {
    expect(await makeStore().list()).toEqual([]);
  });

  it("损坏文件 → 隔离为 .corrupt 并回空态重建", async () => {
    await fsp.writeFile(file, "{ 不是 JSON", "utf8");
    const store = makeStore();
    expect(await store.list()).toEqual([]);
    // 原文件被搬到 .corrupt（保留现场），后续追加正常重建
    const corrupt = await fsp.readFile(file + ".corrupt", "utf8");
    expect(corrupt).toContain("不是 JSON");
    await store.append(entry("a", 1));
    expect(await store.count()).toBe(1);
  });

  it("ensureMaterialized：缺失时写空结构，已有数据不动", async () => {
    const store = makeStore();
    await store.ensureMaterialized();
    expect(JSON.parse(await fsp.readFile(file, "utf8"))).toEqual({ version: 1, entries: [] });
    // 已有数据再调不清空
    await store.append(entry("a", 1));
    await store.ensureMaterialized();
    expect(await store.count()).toBe(1);
  });

  it("clear 清空并落盘", async () => {
    const store = makeStore();
    await store.append(entry("a", 1));
    await store.clear();
    expect(await store.count()).toBe(0);
    expect((await makeStore().list())).toEqual([]);
  });
});

describe("newReplyHistoryId", () => {
  it("生成的 id 唯一且仅含安全字符", () => {
    const a = newReplyHistoryId();
    const b = newReplyHistoryId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[\w-]+$/);
  });
});
