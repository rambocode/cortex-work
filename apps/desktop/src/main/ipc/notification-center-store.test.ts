// 消息中心存储核心单测：重点是两条保留策略（60 天过期 / 500 条上限）与 dedupe 语义——
// 它们是这个 store 相对 notes-store 唯一多出来的逻辑，也是唯一会静默丢数据的地方。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, promises as fsp } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  NotificationStore,
  NOTIFICATION_MAX_ITEMS,
  NOTIFICATION_TTL_MS,
  pruneNotifications,
} from "./notification-center-store";
import type { NotificationRecord } from "./types";

const NOW = 1_700_000_000_000;
let home = "";

function storeAt(now: () => number = () => NOW): NotificationStore {
  return new NotificationStore({
    notificationsStorePath: () => join(home, "notifications.json"),
    now,
  });
}

function rec(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: `n-${Math.random().toString(36).slice(2)}`,
    source: "automation",
    level: "info",
    title: "t",
    createdAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cortex-ntf-"));
});
afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true });
});

describe("pruneNotifications 保留策略", () => {
  it("剔除超过 60 天的记录，边界内的保留", () => {
    const items = [
      rec({ id: "fresh", createdAt: NOW - 1000 }),
      rec({ id: "edge-in", createdAt: NOW - NOTIFICATION_TTL_MS + 1000 }),
      rec({ id: "expired", createdAt: NOW - NOTIFICATION_TTL_MS - 1000 }),
    ];
    const kept = pruneNotifications(items, NOW).map((n) => n.id);
    expect(kept).toContain("fresh");
    expect(kept).toContain("edge-in");
    expect(kept).not.toContain("expired");
  });

  it("超出条数上限时按时间倒序保留最新的一批", () => {
    // 造 上限+10 条，createdAt 递增 → 最旧的 10 条应被丢弃。
    const items = Array.from({ length: NOTIFICATION_MAX_ITEMS + 10 }, (_, i) =>
      rec({ id: `n${i}`, createdAt: NOW - (NOTIFICATION_MAX_ITEMS + 10 - i) * 1000 }),
    );
    const kept = pruneNotifications(items, NOW);
    expect(kept).toHaveLength(NOTIFICATION_MAX_ITEMS);
    expect(kept[0]!.id).toBe(`n${NOTIFICATION_MAX_ITEMS + 9}`); // 最新在前
    expect(kept.some((n) => n.id === "n0")).toBe(false); // 最旧被裁
  });
});

describe("NotificationStore", () => {
  it("add 后可读回，列表最新在前", async () => {
    let t = NOW;
    const store = storeAt(() => t);
    await store.add({ source: "automation", title: "第一条" });
    t += 1000;
    await store.add({ source: "update", title: "第二条" });

    const list = await store.list();
    expect(list.map((n) => n.title)).toEqual(["第二条", "第一条"]);
    expect(list[0]!.level).toBe("info"); // level 缺省兜底
  });

  it("list 对长期无写入的陈旧记录也做过期过滤", async () => {
    let t = NOW;
    const store = storeAt(() => t);
    await store.add({ source: "automation", title: "旧消息" });
    expect(await store.list()).toHaveLength(1);

    // 时间跳过 60 天且期间没有任何写入 —— 只靠写时裁剪的话这条会被读出来。
    t = NOW + NOTIFICATION_TTL_MS + 1;
    expect(await store.list()).toHaveLength(0);
  });

  it("dedupeKey 拦住未读重复，已读后允许再插一条", async () => {
    const store = storeAt();
    await store.add({ source: "update", title: "新版本 v1", dedupeKey: "update-v1" });
    await store.add({ source: "update", title: "新版本 v1", dedupeKey: "update-v1" });
    expect(await store.list()).toHaveLength(1); // 未读期间不重复

    await store.markRead();
    await store.add({ source: "update", title: "新版本 v1", dedupeKey: "update-v1" });
    expect(await store.list()).toHaveLength(2); // 用户已消费过上一条，可以再提醒
  });

  it("markRead 不传 ids 即全部已读；传 ids 只标指定几条", async () => {
    const store = storeAt();
    const a = await store.add({ source: "automation", title: "a" });
    await store.add({ source: "automation", title: "b" });

    await store.markRead([a.id]);
    const afterOne = await store.list();
    expect(afterOne.find((n) => n.id === a.id)?.readAt).toBe(NOW);
    expect(afterOne.find((n) => n.title === "b")?.readAt).toBeUndefined();

    await store.markRead();
    expect((await store.list()).every((n) => n.readAt != null)).toBe(true);
  });

  it("clear 清空全部", async () => {
    const store = storeAt();
    await store.add({ source: "automation", title: "a" });
    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it("并发 add 不丢更新（串行写队列）", async () => {
    const store = storeAt();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.add({ source: "automation", title: `n${i}` })),
    );
    expect(await store.list()).toHaveLength(20);
  });

  it("文件损坏时按空列表降级，不抛", async () => {
    await fsp.writeFile(join(home, "notifications.json"), "{ not json", "utf8");
    const store = storeAt();
    expect(await store.list()).toEqual([]);
    await store.add({ source: "automation", title: "恢复写入" });
    expect(await store.list()).toHaveLength(1);
  });
});
