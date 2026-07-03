// 对话级记忆存储核心（不依赖 electron）的单测：采纳记录/摘要写入/组装读取/清空/
// LRU 裁剪/损坏隔离。electron 绑定层（ipc/reply.ts）人工验证。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fsp } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ReplyConversationStore } from "./conversation-store";

let dir: string;
let file: string;

function makeStore(maxConversations?: number): ReplyConversationStore {
  return new ReplyConversationStore({ storePath: () => file, maxConversations });
}

const WECHAT = { appBundleId: "com.tencent.xinWeChat", appName: "WeChat" };

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), "reply-conv-"));
  file = join(dir, "conversation-memory.json");
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("ReplyConversationStore", () => {
  it("采纳记录后可组装读回（few-shot 形态），磁盘往返一致", async () => {
    const store = makeStore();
    await store.recordAccepted({ ...WECHAT, counterpart: "张玲玲", draft: "收到，我看下", now: 1 });
    const composed = await store.getComposed(WECHAT.appBundleId, "张玲玲");
    expect(composed).toContain("收到，我看下");

    const reread = makeStore();
    expect(await reread.getComposed(WECHAT.appBundleId, "张玲玲")).toContain("收到，我看下");
  });

  it("counterpart 为空 → 不记录、不组装（key 为 null 的降级契约）", async () => {
    const store = makeStore();
    await store.recordAccepted({ ...WECHAT, counterpart: "", draft: "好的", now: 1 });
    expect(await store.count()).toBe(0);
    expect(await store.getComposed(WECHAT.appBundleId, "")).toBe("");
  });

  it("setSummary 后组装优先用摘要；getSummary 供蒸馏合并", async () => {
    const store = makeStore();
    await store.recordAccepted({ ...WECHAT, counterpart: "张玲玲", draft: "好的", now: 1 });
    await store.setSummary({ ...WECHAT, counterpart: "张玲玲", summary: "- 财务同事", now: 2 });
    expect(await store.getComposed(WECHAT.appBundleId, "张玲玲")).toContain("财务同事");
    expect(await store.getSummary(WECHAT.appBundleId, "张玲玲")).toBe("- 财务同事");
  });

  it("超过桶上限按 updatedAt LRU 淘汰最旧对话", async () => {
    const store = makeStore(2);
    await store.recordAccepted({ ...WECHAT, counterpart: "甲", draft: "a", now: 1 });
    await store.recordAccepted({ ...WECHAT, counterpart: "乙", draft: "b", now: 2 });
    await store.recordAccepted({ ...WECHAT, counterpart: "丙", draft: "c", now: 3 });
    expect(await store.count()).toBe(2);
    expect(await store.getComposed(WECHAT.appBundleId, "甲")).toBe("");
    expect(await store.getComposed(WECHAT.appBundleId, "丙")).toContain("c");
  });

  it("损坏文件 → 隔离 .corrupt 并回空态重建", async () => {
    await fsp.writeFile(file, "not json", "utf8");
    const store = makeStore();
    expect(await store.count()).toBe(0);
    await store.recordAccepted({ ...WECHAT, counterpart: "张玲玲", draft: "好的", now: 1 });
    expect(await store.count()).toBe(1);
    expect(await fsp.readFile(file + ".corrupt", "utf8")).toBe("not json");
  });

  it("clear 清空全部对话记忆", async () => {
    const store = makeStore();
    await store.recordAccepted({ ...WECHAT, counterpart: "张玲玲", draft: "好的", now: 1 });
    await store.clear();
    expect(await store.count()).toBe(0);
  });
});
