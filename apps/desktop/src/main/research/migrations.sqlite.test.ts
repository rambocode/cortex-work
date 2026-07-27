// 迁移的真 SQLite 验收（`pnpm --filter @cortex-work/desktop test:sqlite`）。
//
// 这些性质假 driver 证明不了：外键真的被 SQLite 强制、事务真的整体回滚、
// 版本表真的阻止降级。所以本轮直接吃 createNodeSqliteDriver(":memory:")。
import { describe, expect, it } from "vitest";
import { createNodeSqliteDriver, type SqliteDriver } from "./sqlite-driver";
import { applyMigrations, MIGRATIONS, RESEARCH_SCHEMA_TABLES } from "./migrations";

async function freshDriver(): Promise<SqliteDriver> {
  return createNodeSqliteDriver(":memory:");
}

function tableNames(driver: SqliteDriver): string[] {
  return driver
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>()
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_"));
}

function columnNames(driver: SqliteDriver, table: string): string[] {
  return driver
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>()
    .map((r) => r.name);
}

describe("research migrations（真 SQLite）", () => {
  it("空库全量迁移后建出 spec §13.2 的全部 16 张表", async () => {
    const driver = await freshDriver();
    try {
      const version = applyMigrations(driver);
      expect(version).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
      expect(tableNames(driver).sort()).toEqual([...RESEARCH_SCHEMA_TABLES].sort());
    } finally {
      driver.close();
    }
  });

  // v2 删掉了 model_data_policy（出站策略枚举已移除）。两条路径必须落到同一 schema：
  // 全新库走 v1 建列 → v2 删列；已建过 v1 的旧库只跑 v2。任一路径留下这一列，
  // 仓储的 INSERT（不再提供该值、而它是 NOT NULL 无默认）就会在运行时炸。
  it("v2 后 research_sessions 不再有 model_data_policy 列（新库路径）", async () => {
    const driver = await freshDriver();
    try {
      applyMigrations(driver);
      const columns = columnNames(driver, "research_sessions");
      expect(columns).not.toContain("model_data_policy");
      expect(columns).toContain("user_scope");
    } finally {
      driver.close();
    }
  });

  it("research_reports 持久化报告生成统计", async () => {
    const driver = await createNodeSqliteDriver(":memory:");
    applyMigrations(driver);

    expect(columnNames(driver, "research_reports")).toContain("generation_stats_json");
  });

  it("只跑过 v1 的旧库经 v2 迁移后同样不留该列，且原有会话数据保住", async () => {
    const driver = await freshDriver();
    try {
      // 模拟「上个版本建的库」：只应用 v1。
      applyMigrations(driver, [MIGRATIONS[0]!]);
      driver
        .prepare(
          "INSERT INTO research_sessions (session_id, consumer, objective, mode, status, model_data_policy, user_scope, source_scopes_json, output_json, budget_json, budget_spent_json, created_at, updated_at, round_count, document_count, chunk_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(["old-1", "chat", "旧会话", "quick", "completed", "local_only", "u1", "[]", "{}", "{}", "{}", "t", "t", 0, 0, 0]);

      applyMigrations(driver);

      expect(columnNames(driver, "research_sessions")).not.toContain("model_data_policy");
      // 删列不该动行：旧会话仍然读得到（DROP COLUMN 只重写表结构）。
      const row = driver
        .prepare("SELECT objective FROM research_sessions WHERE session_id = ?")
        .get<{ objective: string }>(["old-1"]);
      expect(row?.objective).toBe("旧会话");
    } finally {
      driver.close();
    }
  });

  // v4 把研究会话与「所选项目」关联起来（报告归档到 <项目>/research/）。
  // 老库里的会话没有项目归属，必须读回 NULL 而不是空串——空串会被归档逻辑
  // 当成「有项目但路径为空」，进而把报告写到错误位置。
  it("v3 老库升到 v4 后 research_sessions 有 project_id 列，且旧行为 NULL", async () => {
    const driver = await freshDriver();
    try {
      // 模拟「v4 之前发布版本建的库」：只应用 v1..v3。
      applyMigrations(
        driver,
        MIGRATIONS.filter((m) => m.version <= 3),
      );
      driver
        .prepare(
          "INSERT INTO research_sessions (session_id, consumer, objective, mode, status, user_scope, source_scopes_json, output_json, budget_json, budget_spent_json, created_at, updated_at, round_count, document_count, chunk_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(["old-v3", "chat", "旧会话", "quick", "completed", "u1", "[]", "{}", "{}", "{}", "t", "t", 0, 0, 0]);

      applyMigrations(driver);

      expect(columnNames(driver, "research_sessions")).toContain("project_id");
      const row = driver
        .prepare("SELECT project_id FROM research_sessions WHERE session_id = ?")
        .get<{ project_id: string | null }>(["old-v3"]);
      expect(row?.project_id).toBeNull();
    } finally {
      driver.close();
    }
  });

  it("v4 重复应用幂等：project_id 只加一次，不会因重复 ALTER 抛错", async () => {
    const driver = await freshDriver();
    try {
      applyMigrations(driver);
      expect(() => applyMigrations(driver)).not.toThrow();
      const projectIdColumns = columnNames(driver, "research_sessions").filter((n) => n === "project_id");
      expect(projectIdColumns).toEqual(["project_id"]);
    } finally {
      driver.close();
    }
  });

  it("重复执行幂等：版本不变、不重复建表、schema_migrations 不多行", async () => {
    const driver = await freshDriver();
    try {
      const first = applyMigrations(driver);
      const second = applyMigrations(driver);
      expect(second).toBe(first);
      const rows = driver.prepare("SELECT version FROM schema_migrations ORDER BY version").all<{ version: number }>();
      expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
    } finally {
      driver.close();
    }
  });

  it("数据库版本高于代码已知版本时拒绝启动（旧版本不得改动新库）", async () => {
    const driver = await freshDriver();
    try {
      applyMigrations(driver);
      driver
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run([9999, "2026-07-25T00:00:00.000Z"]);
      expect(() => applyMigrations(driver)).toThrow(/9999/);
    } finally {
      driver.close();
    }
  });

  it("外键真的生效：孤儿子记录被拒绝", async () => {
    const driver = await freshDriver();
    try {
      applyMigrations(driver);
      expect(() =>
        driver
          .prepare(
            "INSERT INTO research_rounds (session_id, round_index, started_at, query_ids_json, candidate_count, document_count, chunk_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(["ghost-session", 0, "2026-07-25T00:00:00.000Z", "[]", 0, 0, 0]),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      driver.close();
    }
  });

  it("删除 session 级联清理子表", async () => {
    const driver = await freshDriver();
    try {
      applyMigrations(driver);
      driver
        .prepare(
          "INSERT INTO research_sessions (session_id, consumer, objective, mode, status, user_scope, source_scopes_json, output_json, budget_json, budget_spent_json, created_at, updated_at, round_count, document_count, chunk_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(["s1", "chat", "o", "quick", "created", "u1", "[]", "{}", "{}", "{}", "t", "t", 0, 0, 0]);
      driver
        .prepare(
          "INSERT INTO research_rounds (session_id, round_index, started_at, query_ids_json, candidate_count, document_count, chunk_count) VALUES (?,?,?,?,?,?,?)",
        )
        .run(["s1", 0, "t", "[]", 0, 0, 0]);

      driver.prepare("DELETE FROM research_sessions WHERE session_id = ?").run(["s1"]);
      expect(driver.prepare("SELECT COUNT(*) AS n FROM research_rounds").get<{ n: number }>()?.n).toBe(0);
    } finally {
      driver.close();
    }
  });

  it("迁移中途抛错整体回滚：既不留半张表，也不留版本记录", async () => {
    const driver = await freshDriver();
    try {
      const broken = [
        MIGRATIONS[0]!,
        { version: 999_001, sql: "CREATE TABLE cre_probe (id INTEGER PRIMARY KEY);" },
        { version: 999_002, sql: "THIS IS NOT SQL;" },
      ];
      expect(() => applyMigrations(driver, broken)).toThrow();
      expect(tableNames(driver)).not.toContain("cre_probe");
      expect(tableNames(driver)).not.toContain("schema_migrations");
    } finally {
      driver.close();
    }
  });

  it("关键索引已建立（跨 session 复用、list、chunk 反查、operation 恢复）", async () => {
    const driver = await freshDriver();
    try {
      applyMigrations(driver);
      const indexes = driver
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all<{ name: string }>()
        .map((r) => r.name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          "idx_research_documents_content_hash",
          "idx_research_sessions_status_updated",
          "idx_document_chunks_document",
          "idx_research_operations_session_committed",
        ]),
      );
    } finally {
      driver.close();
    }
  });
});

describe("createNodeSqliteDriver（真 SQLite）", () => {
  it("transaction 抛错时整体回滚", async () => {
    const driver = await freshDriver();
    try {
      driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      expect(() =>
        driver.transaction(() => {
          driver.prepare("INSERT INTO t (id) VALUES (?)").run([1]);
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(driver.prepare("SELECT COUNT(*) AS n FROM t").get<{ n: number }>()?.n).toBe(0);
    } finally {
      driver.close();
    }
  });

  it("禁止嵌套事务（防止内层 COMMIT 提前落地外层的半成品写入）", async () => {
    const driver = await freshDriver();
    try {
      expect(() => driver.transaction(() => driver.transaction(() => 1))).toThrow(/嵌套/);
      // 外层失败后事务状态必须复位，后续事务仍可正常提交。
      driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      driver.transaction(() => driver.prepare("INSERT INTO t (id) VALUES (?)").run([1]));
      expect(driver.prepare("SELECT COUNT(*) AS n FROM t").get<{ n: number }>()?.n).toBe(1);
    } finally {
      driver.close();
    }
  });

  it("位置参数支持 null 与 Uint8Array，statement 复用同一条 SQL", async () => {
    const driver = await freshDriver();
    try {
      driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b BLOB)");
      const sql = "INSERT INTO t (id, a, b) VALUES (?, ?, ?)";
      expect(driver.prepare(sql)).toBe(driver.prepare(sql));
      driver.prepare(sql).run([1, null, new Uint8Array([1, 2, 3])]);
      const row = driver.prepare("SELECT a, b FROM t WHERE id = ?").get<{ a: string | null; b: Uint8Array }>([1]);
      expect(row?.a).toBeNull();
      expect(Array.from(row?.b ?? [])).toEqual([1, 2, 3]);
    } finally {
      driver.close();
    }
  });

  it("run 返回归一化的 changes 数字", async () => {
    const driver = await freshDriver();
    try {
      driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      driver.prepare("INSERT INTO t (id) VALUES (?)").run([1]);
      driver.prepare("INSERT INTO t (id) VALUES (?)").run([2]);
      const result = driver.prepare("DELETE FROM t").run();
      expect(result.changes).toBe(2);
    } finally {
      driver.close();
    }
  });
});
