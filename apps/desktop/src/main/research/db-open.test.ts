// 数据库损坏时的 fail-closed 恢复测试（spec §13.2：先复制损坏文件再重建，不静默覆盖）。
import { describe, expect, it } from "vitest";
import type { SqliteDriver } from "./sqlite-driver";
import { openResearchDatabase } from "./db-open";

/// 最小的假 driver，只要能被"打开成功"这件事观察到即可。
function fakeDriver(tag: string): SqliteDriver {
  return {
    exec: () => {},
    prepare: () => ({ run: () => ({ changes: 0, lastInsertRowid: 0 }), get: () => undefined, all: () => [] }),
    transaction: <T>(fn: () => T) => fn(),
    close: () => {},
    // 便于断言是哪一次创建出来的
    ...({ tag } as unknown as object),
  } as SqliteDriver;
}

describe("openResearchDatabase", () => {
  it("正常路径：建连接 + 跑迁移，不隔离任何文件", async () => {
    const quarantined: string[] = [];
    let migrated = 0;

    const driver = await openResearchDatabase({
      dbPath: "/data/research.sqlite",
      ensureDbDir: async () => {},
      createDriver: async () => fakeDriver("first"),
      migrate: () => {
        migrated += 1;
      },
      quarantine: async (path) => {
        quarantined.push(path);
        return `${path}.bak`;
      },
    });

    expect(driver).toBeDefined();
    expect(migrated).toBe(1);
    expect(quarantined).toEqual([]);
  });

  // 首次启动时 ~/.cortex-desktop/research/ 还不存在，node:sqlite 会直接报
  // "unable to open database file"，随后隔离又因主库不存在而 ENOENT，整条链路死锁在首启。
  it("首次打开：先建目录再建连接（目录不存在时 sqlite 无法创建库文件）", async () => {
    const order: string[] = [];

    await openResearchDatabase({
      dbPath: "/data/research.sqlite",
      ensureDbDir: async () => {
        order.push("mkdir");
      },
      createDriver: async () => {
        order.push("open");
        return fakeDriver("first");
      },
      migrate: () => {},
      quarantine: async () => "/data/research.sqlite.bak",
    });

    expect(order).toEqual(["mkdir", "open"]);
  });

  it("建目录失败直接抛错，且不隔离（此时根本没有可隔离的库）", async () => {
    let quarantineCalls = 0;

    await expect(
      openResearchDatabase({
        dbPath: "/data/research.sqlite",
        ensureDbDir: async () => {
          throw new Error("EACCES: permission denied");
        },
        createDriver: async () => fakeDriver("x"),
        migrate: () => {},
        quarantine: async () => {
          quarantineCalls += 1;
          return "/data/research.sqlite.bak";
        },
      }),
    ).rejects.toThrow(/EACCES/);
    expect(quarantineCalls).toBe(0);
  });

  it("打开或迁移失败：先隔离损坏文件，再用干净库重建", async () => {
    const quarantined: string[] = [];
    let attempt = 0;

    const driver = await openResearchDatabase({
      dbPath: "/data/research.sqlite",
      ensureDbDir: async () => {},
      createDriver: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("file is not a database");
        return fakeDriver("rebuilt");
      },
      migrate: () => {},
      quarantine: async (path) => {
        quarantined.push(path);
        return `${path}.corrupt-1`;
      },
    });

    expect(driver).toBeDefined();
    expect(attempt).toBe(2);
    // 隔离必须发生在重建之前：直接重建会永久覆盖用户数据
    expect(quarantined).toEqual(["/data/research.sqlite"]);
  });

  it("迁移失败也走隔离重建（半迁移的库同样不可用）", async () => {
    let migrateCalls = 0;
    let quarantineCalls = 0;

    await openResearchDatabase({
      dbPath: "/data/research.sqlite",
      ensureDbDir: async () => {},
      createDriver: async () => fakeDriver("x"),
      migrate: () => {
        migrateCalls += 1;
        if (migrateCalls === 1) throw new Error("schema 版本过高");
      },
      quarantine: async () => {
        quarantineCalls += 1;
        return "/data/research.sqlite.corrupt-1";
      },
    });

    expect(quarantineCalls).toBe(1);
    expect(migrateCalls).toBe(2);
  });

  it("重建仍失败时抛错（fail closed，绝不返回一个不可用的连接）", async () => {
    await expect(
      openResearchDatabase({
        dbPath: "/data/research.sqlite",
        ensureDbDir: async () => {},
        createDriver: async () => {
          throw new Error("磁盘只读");
        },
        migrate: () => {},
        quarantine: async () => "/data/research.sqlite.corrupt-1",
      }),
    ).rejects.toThrow(/磁盘只读/);
  });

  it("隔离本身失败时不重建，直接抛原始错误（宁可打不开，也不覆盖用户数据）", async () => {
    let attempts = 0;
    await expect(
      openResearchDatabase({
        dbPath: "/data/research.sqlite",
        ensureDbDir: async () => {},
        createDriver: async () => {
          attempts += 1;
          throw new Error("file is not a database");
        },
        migrate: () => {},
        quarantine: async () => {
          throw new Error("权限不足");
        },
      }),
    ).rejects.toThrow(/file is not a database/);
    expect(attempts).toBe(1);
  });
});
