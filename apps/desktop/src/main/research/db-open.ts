// research.sqlite 的打开与损坏恢复（spec §13.2「数据库损坏时 fail closed，
// 先复制损坏文件再重建，不静默覆盖」）。
//
// 为什么这层归装配方而不是 sqlite-driver：driver 只负责"给我一个连接"，
// 它既不知道数据库在哪、也不该决定"打不开时怎么办"。恢复策略牵涉用户数据的取舍
//（隔离一份、重建一个空库），必须在能看到全局的装配层做，且要能被单测钉死。
//
// 恢复顺序不可换：**先隔离，后重建**。反过来做等于用一个空库永久覆盖用户的研究历史。
// 隔离失败时直接抛原始错误——宁可这次打不开，也不能冒覆盖数据的风险。
import type { SqliteDriver } from "./sqlite-driver";

/// 注入依赖。全部可替换，因此这段逻辑不需要真实文件系统就能测。
export interface OpenResearchDatabaseDeps {
  dbPath: string;
  /// 确保 dbPath 所在目录存在（生产为 mkdir -p）。**必填**：node:sqlite 只会创建库文件、
  /// 不会创建父目录，首启时 ~/.cortex-desktop/research/ 还不存在，会报
  /// "unable to open database file"——一个看起来像"库损坏"、实则只是目录缺失的错误。
  ensureDbDir: () => Promise<void>;
  createDriver: (path: string) => Promise<SqliteDriver>;
  /// 应用迁移（生产传 applyMigrations）。抛错视同库不可用。
  migrate: (driver: SqliteDriver) => void;
  /// 把损坏的库挪到一边并返回备份路径。实现必须**先复制后删除**。
  quarantine: (dbPath: string) => Promise<string>;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

/// 打开研究数据库；损坏时隔离并重建。
export async function openResearchDatabase(deps: OpenResearchDatabaseDeps): Promise<SqliteDriver> {
  // 建目录放在 try 之外：目录建不出来时"隔离 + 重建"毫无意义（连库文件都还不存在，
  // 隔离只会以 ENOENT 二次失败、把真正的原因盖掉），直接抛原始的 mkdir 错误更好诊断。
  await deps.ensureDbDir();

  try {
    return await openAndMigrate(deps);
  } catch (firstError) {
    deps.logger?.warn("[research] 打开数据库失败，准备隔离并重建", firstError);

    let backupPath: string;
    try {
      backupPath = await deps.quarantine(deps.dbPath);
    } catch (quarantineError) {
      deps.logger?.warn("[research] 隔离损坏数据库失败，放弃重建", quarantineError);
      // 抛**原始**错误：隔离失败只是次生问题，真正需要被诊断的是库为什么打不开。
      throw firstError;
    }

    deps.logger?.warn(`[research] 已隔离损坏的数据库到 ${backupPath}，将重建空库`);
    // 重建仍失败就让它抛出去：返回一个半死的连接会让后续每次写入都以更难懂的方式失败。
    return await openAndMigrate(deps);
  }
}

/// 建连接并跑迁移。迁移失败时先关掉连接，避免留下句柄（Windows 上会锁住文件，
/// 让紧随其后的隔离动作失败）。
async function openAndMigrate(deps: OpenResearchDatabaseDeps): Promise<SqliteDriver> {
  const driver = await deps.createDriver(deps.dbPath);
  try {
    deps.migrate(driver);
  } catch (err) {
    try {
      driver.close();
    } catch {
      // 连接可能已经不可用，忽略。
    }
    throw err;
  }
  return driver;
}
