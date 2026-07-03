// 回复历史 events 目录存储的单测：按应用分目录、聚合读取、每应用上限淘汰、
// 单文件损坏跳过、清空、history.json 拆分迁移、目录名净化防穿越。
// electron 绑定层（ipc/reply.ts）人工验证。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fsp } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ReplyHistoryEntry } from "@cortex-work/core/reply/history";
import { ReplyHistoryStore, eventDirName, newReplyHistoryId } from "./history-store";

let dir: string;
let eventsDir: string;
let legacyJson: string;

function makeStore(keepPerApp?: number): ReplyHistoryStore {
  return new ReplyHistoryStore({
    eventsDir: () => eventsDir,
    legacyJsonPath: () => legacyJson,
    keepPerApp,
  });
}

/// 最小历史条目工厂。
function entry(id: string, ts: number, patch: Partial<ReplyHistoryEntry> = {}): ReplyHistoryEntry {
  return {
    id,
    ts,
    appName: "微信",
    appBundleId: "com.tencent.xinWeChat",
    counterpart: "张玲玲",
    conversation: "对方：明天方便吗？",
    candidates: [{ text: "可以的", stance: null }],
    acceptedIndex: 0,
    acceptedText: "可以的",
    ...patch,
  };
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), "reply-events-"));
  eventsDir = join(dir, "events");
  legacyJson = join(dir, "history.json");
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("eventDirName", () => {
  it("目录名 = bundleId__appName，CJK 原样保留", () => {
    expect(eventDirName("com.tencent.xinWeChat", "微信")).toBe("com.tencent.xinWeChat__微信");
  });

  it("净化路径分隔符/冒号/前导点，空段回落 unknown", () => {
    expect(eventDirName("../etc", "a/b:c")).toBe("etc__a-b-c");
    expect(eventDirName("", "")).toBe("unknown__unknown");
  });
});

describe("ReplyHistoryStore（events 目录）", () => {
  it("按应用分目录落盘，事件文件带 schemaVersion", async () => {
    const store = makeStore();
    await store.append(entry("a", 1));
    await store.append(entry("b", 2, { appName: "Mail", appBundleId: "com.apple.mail" }));
    const wechat = await fsp.readdir(join(eventsDir, "com.tencent.xinWeChat__微信"));
    expect(wechat).toEqual(["a.json"]);
    const raw = JSON.parse(
      await fsp.readFile(join(eventsDir, "com.tencent.xinWeChat__微信", "a.json"), "utf8"),
    );
    expect(raw.schemaVersion).toBe(1);
    expect(raw.acceptedText).toBe("可以的");
    expect(await fsp.readdir(join(eventsDir, "com.apple.mail__Mail"))).toEqual(["b.json"]);
  });

  it("list 跨应用聚合并按 ts newest-first；count 只数文件", async () => {
    const store = makeStore();
    await store.append(entry("a", 1));
    await store.append(entry("b", 3, { appBundleId: "com.apple.mail", appName: "Mail" }));
    await store.append(entry("c", 2));
    expect((await store.list()).map((e) => e.id)).toEqual(["b", "c", "a"]);
    expect(await store.count()).toBe(3);
  });

  it("每应用超上限按 ts 淘汰最旧（其它应用不受影响）", async () => {
    const store = makeStore(2);
    await store.append(entry("a", 1));
    await store.append(entry("b", 2));
    await store.append(entry("c", 3));
    await store.append(entry("m", 1, { appBundleId: "com.apple.mail", appName: "Mail" }));
    const ids = (await store.list()).map((e) => e.id);
    expect(ids).toContain("c");
    expect(ids).toContain("b");
    expect(ids).not.toContain("a"); // 微信桶最旧的被淘汰
    expect(ids).toContain("m"); // 邮件桶不受影响
  });

  it("单个事件文件损坏 → list 跳过该条不抛", async () => {
    const store = makeStore();
    await store.append(entry("a", 1));
    await fsp.writeFile(join(eventsDir, "com.tencent.xinWeChat__微信", "bad.json"), "{ 坏", "utf8");
    expect((await store.list()).map((e) => e.id)).toEqual(["a"]);
    expect(await store.count()).toBe(2); // count 只数文件,含坏文件
  });

  it("clear 删除全部事件并保留空 events 目录", async () => {
    const store = makeStore();
    await store.append(entry("a", 1));
    await store.clear();
    expect(await store.count()).toBe(0);
    await fsp.access(eventsDir); // 目录仍在（自解释）
  });

  it("ensureMaterialized：建目录 + history.json 拆分迁移后改名 .migrated", async () => {
    await fsp.writeFile(
      legacyJson,
      JSON.stringify({ version: 1, entries: [entry("a", 1), entry("b", 2, { appBundleId: "com.apple.mail", appName: "Mail" })] }),
      "utf8",
    );
    const store = makeStore();
    await store.ensureMaterialized();
    expect(await store.count()).toBe(2);
    expect((await store.list()).map((e) => e.id)).toEqual(["b", "a"]);
    await expect(fsp.access(legacyJson)).rejects.toThrow();
    await fsp.access(legacyJson + ".migrated");
  });

  it("ensureMaterialized 无旧文件时只建空目录", async () => {
    await makeStore().ensureMaterialized();
    expect(await fsp.readdir(eventsDir)).toEqual([]);
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
