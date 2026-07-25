// CRE 的 SQLite schema 与迁移（spec §13.2）。
//
// 规则：
// - **只前进**。已应用的版本不重跑；数据库版本高于代码已知版本时直接抛错——
//   旧版本 App 绝不能改动新版本建的库（字段语义可能已经变了，写进去就是数据损坏）。
// - **整套迁移在一个事务里**。中途任何一步失败都整体回滚，不留「半张表 + 半条版本记录」
//   这种既不能续跑也不能重来的中间态。
// - 外键全开（PRAGMA 在 sqlite-driver 建库时设置），子表一律 ON DELETE CASCADE，
//   删除 Session 即彻底清理其证据链。
import type { SqliteDriver } from "./sqlite-driver";

/// 一次 schema 变更。sql 可以包含多条语句（由 driver.exec 一次执行）。
export interface ResearchMigration {
  version: number;
  sql: string;
}

/// spec §13.2 列出的全部 16 张表，顺序与 spec 一致。
/// 导出的目的是让迁移测试能整表比对，避免「少建一张表但测试照样绿」。
export const RESEARCH_SCHEMA_TABLES = [
  "schema_migrations",
  "research_sessions",
  "research_plans",
  "research_subquestions",
  "research_rounds",
  "research_operations",
  "research_queries",
  "search_candidates",
  "research_documents",
  "document_chunks",
  "duplicate_clusters",
  "coverage_reports",
  "research_reports",
  "citation_links",
  "knowledge_items",
  "memory_candidates",
] as const;

// ---------------------------------------------------------------------------
// v1：全量初始 schema
// ---------------------------------------------------------------------------
//
// 设计要点：
// - **正文不进 SQLite**。research_documents 只存 content_ref（blob 引用）与 text_length，
//   正文落在 blobs/ 下（spec §19.4：1000 篇文档的 list/get summary 不读 blob）。
//   document_chunks.text 是例外——证据片段本来就短，且引用校验要按 chunk 精确定位。
// - 计数列（round_count / document_count / chunk_count）是**刻意的冗余**：
//   ResearchSessionSummary 需要这三个数，而 summary 路径绝不允许 join 证据表（spec §19.3.2）。
//   它们由提交事务在写入证据的同一笔事务里累加，不存在漂移窗口。
// - 结构复杂但整体读写的对象（scope、completion、engines、subquestion_scores 等）存 JSON 列：
//   它们从不参与 WHERE / JOIN，拆成表只增加迁移成本，不带来查询能力。
const V1_SQL = `
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE research_sessions (
  session_id         TEXT PRIMARY KEY,
  consumer           TEXT NOT NULL,
  objective          TEXT NOT NULL,
  mode               TEXT NOT NULL,
  status             TEXT NOT NULL,
  model_data_policy  TEXT NOT NULL,
  -- KTD9 跨 Session 复用的隔离键（当前用户/工作区）。复用查询必须带上它，
  -- 否则换个账号登录就能读到上一位用户抓取的内容。
  user_scope         TEXT NOT NULL,
  source_scopes_json TEXT NOT NULL,
  output_json        TEXT NOT NULL,
  budget_json        TEXT NOT NULL,
  budget_spent_json  TEXT NOT NULL,
  error_message      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  round_count        INTEGER NOT NULL DEFAULT 0,
  document_count     INTEGER NOT NULL DEFAULT 0,
  chunk_count        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE research_plans (
  session_id      TEXT PRIMARY KEY REFERENCES research_sessions(session_id) ON DELETE CASCADE,
  schema_version  INTEGER NOT NULL,
  objective       TEXT NOT NULL,
  scope_json      TEXT NOT NULL,
  budget_json     TEXT NOT NULL,
  completion_json TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE research_subquestions (
  session_id     TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE CASCADE,
  subquestion_id TEXT NOT NULL,
  text           TEXT NOT NULL,
  rationale      TEXT,
  position       INTEGER NOT NULL,
  PRIMARY KEY (session_id, subquestion_id)
);

CREATE TABLE research_rounds (
  session_id      TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE CASCADE,
  round_index     INTEGER NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  decision        TEXT,
  query_ids_json  TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  document_count  INTEGER NOT NULL,
  chunk_count     INTEGER NOT NULL,
  PRIMARY KEY (session_id, round_index)
);

-- spec §9.1 的原子提交边界：先落 pending，再调外部服务，最后在一个事务里
-- 写证据并置 committed_at。崩溃恢复时 committed_at IS NULL 的即为需重试的操作。
CREATE TABLE research_operations (
  operation_id         TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL,
  request_payload_hash TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  committed_at         TEXT,
  retryable            INTEGER NOT NULL DEFAULT 0
);

-- query_id 只在 Session 内唯一（Planner 生成的是 q-1、q-2 这类局部 id），
-- 因此主键是复合键；document_id / chunk_id 则必须全局唯一，见下方两表。
CREATE TABLE research_queries (
  query_id              TEXT NOT NULL,
  session_id            TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE CASCADE,
  subquestion_id        TEXT NOT NULL,
  -- NULL 表示初始计划里的查询；非 NULL 表示某一轮 Gap Planner 补充的查询。
  round_index           INTEGER,
  text                  TEXT NOT NULL,
  language              TEXT,
  categories_json       TEXT,
  time_range            TEXT,
  domain_allowlist_json TEXT,
  domain_blocklist_json TEXT,
  limit_value           INTEGER,
  position              INTEGER NOT NULL,
  PRIMARY KEY (session_id, query_id)
);

CREATE TABLE search_candidates (
  candidate_id  TEXT NOT NULL,
  session_id    TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE CASCADE,
  query_id      TEXT NOT NULL,
  round_index   INTEGER NOT NULL,
  title         TEXT NOT NULL,
  url           TEXT NOT NULL,
  canonical_url TEXT,
  -- KTD3：搜索摘要只用于排序与选择，**禁止进入最终 Claim**；存下来仅供调试与 UI 展示。
  snippet       TEXT,
  domain        TEXT NOT NULL,
  engines_json  TEXT NOT NULL,
  source_type   TEXT,
  published_at  TEXT,
  server_score  REAL NOT NULL,
  trust_zone    TEXT NOT NULL,
  PRIMARY KEY (session_id, candidate_id)
);

-- document_id / chunk_id 必须**全局**唯一：CitationRef 在报告、IPC 和 UI 里只带 id 不带 session，
-- 且跨 Session 复用查询会返回别的 Session 的文档行。生成方须用 uuid 级 id。
CREATE TABLE research_documents (
  document_id   TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE CASCADE,
  candidate_id  TEXT,
  source_json   TEXT NOT NULL,
  title         TEXT NOT NULL,
  canonical_url TEXT,
  content_hash  TEXT NOT NULL,
  simhash       TEXT,
  media_type    TEXT NOT NULL,
  fetch_method  TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  published_at  TEXT,
  -- 正文的 blob 引用（blob:<sha256>），正文本身不在 SQLite 里。
  content_ref   TEXT NOT NULL,
  text_length   INTEGER NOT NULL,
  duplicate_of  TEXT,
  policy_json   TEXT NOT NULL,
  -- 冗余自所属 Session：跨 Session 复用查询要按 (content_hash, user_scope) 命中，
  -- 若每次都 join research_sessions，复用查询会退化成全表扫描。
  user_scope    TEXT NOT NULL
);

CREATE TABLE document_chunks (
  chunk_id               TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE CASCADE,
  document_id            TEXT NOT NULL REFERENCES research_documents(document_id) ON DELETE CASCADE,
  page                   INTEGER,
  start_offset           INTEGER,
  end_offset             INTEGER,
  heading_path_json      TEXT,
  text                   TEXT NOT NULL,
  text_hash              TEXT NOT NULL,
  objective_score        REAL NOT NULL,
  subquestion_scores_json TEXT NOT NULL,
  trust_zone             TEXT NOT NULL,
  position               INTEGER NOT NULL
);

CREATE TABLE duplicate_clusters (
  cluster_id          TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE CASCADE,
  representative_hash TEXT NOT NULL,
  member_hashes_json  TEXT NOT NULL
);

CREATE TABLE coverage_reports (
  session_id               TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE CASCADE,
  round_index              INTEGER NOT NULL,
  subquestion_id           TEXT NOT NULL,
  status                   TEXT NOT NULL,
  source_count             INTEGER NOT NULL,
  independent_domain_count INTEGER NOT NULL,
  primary_source_count     INTEGER NOT NULL,
  contradiction_count      INTEGER NOT NULL,
  average_relevance        REAL NOT NULL,
  best_chunk_ids_json      TEXT NOT NULL,
  missing_json             TEXT NOT NULL,
  PRIMARY KEY (session_id, round_index, subquestion_id)
);

CREATE TABLE research_reports (
  session_id               TEXT PRIMARY KEY REFERENCES research_sessions(session_id) ON DELETE CASCADE,
  markdown                 TEXT NOT NULL,
  unsupported_sections_json TEXT NOT NULL,
  generated_at             TEXT NOT NULL
);

CREATE TABLE citation_links (
  session_id   TEXT NOT NULL REFERENCES research_sessions(session_id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  chunk_id     TEXT NOT NULL,
  document_id  TEXT NOT NULL,
  title        TEXT NOT NULL,
  url          TEXT,
  page         INTEGER,
  retrieved_at TEXT NOT NULL,
  text_hash    TEXT NOT NULL,
  PRIMARY KEY (session_id, position)
);

-- ⚠️ knowledge_items 与 memory_candidates 是 **U10 的留位**：M1 阶段建表但**没有任何读写代码**。
-- 现在就建，是为了 U10 落地时不必再动 schema（迁移只前进，加表就得再发一版）。
-- KTD10 红线：MemoryCandidate 必须 status='approved' 才可进入 buildMemoryAppend()，
-- 审批动作由用户在 UI 上逐条完成；任何绕过 status 直接写 Memory 的路径都是 bug。
CREATE TABLE knowledge_items (
  knowledge_id         TEXT PRIMARY KEY,
  session_id           TEXT REFERENCES research_sessions(session_id) ON DELETE SET NULL,
  subject              TEXT NOT NULL,
  statement            TEXT NOT NULL,
  confidence           TEXT NOT NULL,
  citation_chunk_ids_json TEXT NOT NULL,
  trust_zones_json     TEXT NOT NULL,
  valid_from           TEXT,
  valid_until          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE memory_candidates (
  candidate_id         TEXT PRIMARY KEY,
  knowledge_id         TEXT NOT NULL REFERENCES knowledge_items(knowledge_id) ON DELETE CASCADE,
  scope                TEXT NOT NULL,
  text                 TEXT NOT NULL,
  citation_chunk_ids_json TEXT NOT NULL,
  status               TEXT NOT NULL,
  approved_at          TEXT,
  created_at           TEXT NOT NULL
);

-- 跨 Session 复用的主查询（KTD9）：按内容哈希找已抓取快照。
CREATE INDEX idx_research_documents_content_hash ON research_documents(content_hash, user_scope);
-- Session 列表与启动恢复都按「状态 + 最近更新」取数。
CREATE INDEX idx_research_sessions_status_updated ON research_sessions(status, updated_at DESC);
-- evidence 层级读取按文档反查 chunk。
CREATE INDEX idx_document_chunks_document ON document_chunks(document_id);
-- 崩溃恢复扫描「本 Session 中 committed_at IS NULL」的操作。
CREATE INDEX idx_research_operations_session_committed ON research_operations(session_id, committed_at);
`;

/// 全部迁移，按 version 升序。**只追加，永不修改已发布的条目**——
/// 已经跑过 v1 的用户库不会重跑 v1，就地改 V1_SQL 只会造成新老库 schema 不一致。
export const MIGRATIONS: readonly ResearchMigration[] = [{ version: 1, sql: V1_SQL }];

/// 把 migrations 应用到数据库，返回应用后的最终版本号。
///
/// migrations 参数只为测试注入（验证「中途抛错整体回滚」需要一条必然失败的迁移），
/// 生产调用一律用默认值。
export function applyMigrations(
  driver: SqliteDriver,
  migrations: readonly ResearchMigration[] = MIGRATIONS,
): number {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const latestKnown = ordered.length === 0 ? 0 : ordered[ordered.length - 1]!.version;
  const applied = readAppliedVersions(driver);

  // 降级保护：库里存在代码不认识的版本，说明用户曾用更新版 App 打开过这个库。
  // 此时继续写入等于用旧语义改新数据，必须 fail closed（spec §13.2「数据库损坏时 fail closed」同理）。
  for (const version of applied) {
    if (version > latestKnown) {
      throw new Error(
        `research.sqlite 的 schema 版本 ${version} 高于本版本 App 已知的 ${latestKnown}，拒绝降级写入`,
      );
    }
  }

  const pending = ordered.filter((m) => !applied.has(m.version));
  if (pending.length === 0) return latestKnown;

  // 整套 pending 迁移放在同一个事务里：中途失败则一张表都不留，
  // 下次启动从干净状态重来，而不是停在半迁移状态。
  driver.transaction(() => {
    const appliedAt = new Date().toISOString();
    for (const migration of pending) {
      driver.exec(migration.sql);
      driver
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run([migration.version, appliedAt]);
    }
  });

  return latestKnown;
}

/// 读已应用的版本集合。schema_migrations 尚不存在（全新库）时返回空集合，
/// 而不是抛错——「表不存在」正是全新库的正常形态。
function readAppliedVersions(driver: SqliteDriver): Set<number> {
  const exists = driver
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get<{ name: string }>();
  if (!exists) return new Set();
  return new Set(
    driver.prepare("SELECT version FROM schema_migrations").all<{ version: number }>().map((r) => Number(r.version)),
  );
}
