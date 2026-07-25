// CRE 的 SQLite 抽象层（spec §13.2）。
//
// 定位：这是**全仓唯一**允许接触 `node:sqlite` 的文件。其余代码（migrations、
// ResearchRepository、启动恢复）一律只依赖本文件导出的 `SqliteDriver` 接口，
// 这样默认测试轮（系统 Node 20，没有 node:sqlite）能靠替身跑通，
// 真 SQLite 轮（ELECTRON_RUN_AS_NODE=1 electron，内嵌 Node 22）再验证真实行为。
//
// 为什么 `node:sqlite` 必须**动态** import：系统 Node 20 上顶层静态 import 会在模块解析阶段
// 直接抛 ERR_UNKNOWN_BUILTIN_MODULE，把整个模块图炸掉——连不碰 SQLite 的测试也会红。
// 动态 import 把这个风险收敛到 createNodeSqliteDriver 被真正调用的那一刻。

/// SQLite 位置参数可承载的值域。undefined 不在其中：调用方必须显式写 null，
/// 否则「字段忘了传」会被 SQLite 当成缺参数而不是 NULL，静默写坏数据。
export type SqlValue = string | number | bigint | null | Uint8Array;

/// 一条已编译的语句。三个方法都接收**位置参数数组**。
export interface SqliteStatement {
  run(params?: readonly SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  get<T>(params?: readonly SqlValue[]): T | undefined;
  all<T>(params?: readonly SqlValue[]): T[];
}

/// 数据库连接的最小面。刻意不暴露底层 DatabaseSync：
/// 一旦泄漏出去，`node:sqlite` 的实验性 API 漂移就会渗透到整个仓库。
export interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /// BEGIN IMMEDIATE → fn() → COMMIT；fn 抛出则 ROLLBACK 并把异常原样抛给调用方。
  ///
  /// **回调必须是同步的**（返回值不得是 Promise）。理由是 spec §9.1 的原子提交边界：
  /// node:sqlite 只有一个同步连接，事务是连接级状态。回调里一旦 await，事件循环就会把
  /// 别的 operation 的写入穿插进这个尚未 COMMIT 的事务里，两笔操作会一起提交或一起回滚——
  /// 「Worker 返回后不能先修改内存状态再异步落盘」这条约束将彻底失效。
  transaction<T>(fn: () => T): T;
  close(): void;
}

/// `node:sqlite` 的 DatabaseSync 最小结构类型。
/// 手写而不是 import 官方类型：`@types/node` 20 里没有这些声明，静态引用会让 typecheck 失败。
interface NodeSqliteStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}
interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

/// 创建一个基于 `node:sqlite` 的真实连接。
///
/// 建库即开两个 PRAGMA：
/// - `foreign_keys = ON`：SQLite 默认**关闭**外键，不开的话 spec §13.2 的级联删除形同虚设，
///   删 Session 会留下一地孤儿证据。
/// - `journal_mode = WAL`：写事务不阻塞读，且崩溃后能靠 WAL 恢复到最后一个提交点，
///   契合「崩溃恢复只重试未 committed operation」的模型。`:memory:` 库会忽略该 PRAGMA，无副作用。
export async function createNodeSqliteDriver(path: string): Promise<SqliteDriver> {
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
    DatabaseSync: new (p: string) => NodeSqliteDatabase;
  };
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  return new NodeSqliteDriver(db);
}

/// SqliteDriver 的 node:sqlite 实现。
class NodeSqliteDriver implements SqliteDriver {
  /// SQL 文本 → 已编译语句。热路径（逐条插入 chunk）会把同一条 SQL 走上千次，
  /// 每次重新 prepare 是纯浪费；语句本身无状态（参数每次调用时传），缓存是安全的。
  private readonly statements = new Map<string, SqliteStatement>();
  /// 事务深度。只用来拒绝嵌套，不做「保存点」语义——见 transaction 的注释。
  private depth = 0;
  private closed = false;

  constructor(private readonly db: NodeSqliteDatabase) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const stmt = wrapStatement(this.db.prepare(sql));
    this.statements.set(sql, stmt);
    return stmt;
  }

  transaction<T>(fn: () => T): T {
    // 禁止嵌套：SQLite 没有真正的嵌套事务，内层的 COMMIT 会直接把外层尚未完成的写入
    // 一并提交，随后外层的 ROLLBACK 又无事可回滚——这正是「部分写入」事故的经典成因。
    // 需要嵌套语义时应改用 SAVEPOINT，但 CRE 的提交边界是单层的，所以这里直接拒绝，
    // 让误用在开发期就炸出来而不是在用户机器上悄悄写坏数据。
    if (this.depth > 0) throw new Error("SqliteDriver.transaction 不支持嵌套事务");
    this.depth = 1;
    // BEGIN IMMEDIATE 而非 BEGIN：立刻取写锁，避免读事务升级为写事务时才发现冲突（SQLITE_BUSY）。
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      if (isThenable(result)) {
        // fn 返回 Promise 说明回调里有异步逻辑，事务边界已经不可信（见接口注释）。
        // 此时必须回滚：那些 await 之后的写入根本不在这个事务里。
        throw new Error("SqliteDriver.transaction 的回调必须是同步的，不能返回 Promise");
      }
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 事务已被 SQLite 自动回滚（例如 SQLITE_FULL）时 ROLLBACK 会报「no transaction is active」，
        // 吞掉它，否则会掩盖真正的业务异常 err。
      }
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }
}

/// 判断一个值是否是 thenable（用来识别「回调里偷偷写了 async」）。
function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/// 把 node:sqlite 的展开参数风格包成「位置参数数组」风格。
///
/// 为什么全仓只用 `?` + 数组、不用命名参数：`node:sqlite` 对命名参数的裸名支持
/// （`setAllowBareNamedParameters`）在 Node 22 各小版本间有过默认值漂移，
/// 同一段 `{ $id: 1 }` / `{ id: 1 }` 代码在不同 Electron 版本上行为可能不同。
/// 位置参数没有这个歧义面，是跨版本最稳的写法。
function wrapStatement(stmt: NodeSqliteStatement): SqliteStatement {
  return {
    run(params = []) {
      const result = stmt.run(...params);
      // changes 在开启 readBigInts 时是 bigint；统一归一成 number，
      // 免得调用方到处写 Number(...)，也免得 `=== 0` 这类比较悄悄失效。
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    },
    get<T>(params: readonly SqlValue[] = []) {
      return stmt.get(...params) as T | undefined;
    },
    all<T>(params: readonly SqlValue[] = []) {
      return stmt.all(...params) as T[];
    },
  };
}
