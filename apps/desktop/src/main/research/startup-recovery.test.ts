// 启动恢复的自动化验收（spec §19.1.4：应用在任一运行阶段退出，重启后 Session 进入 interrupted）。
//
// 用 InMemoryResearchRepository + 手写 tmp 文件系统替身，零 mock 框架：
// 五个非终态各造一条 Session，断言全部被归一成 interrupted，且终态/静止态原样不动。
import { describe, expect, it } from "vitest";
import { NON_TERMINAL_RESEARCH_STATUSES } from "@cortex-work/core/research/session-status";
import { InMemoryResearchRepository } from "./repository-memory";
import { runResearchStartupRecovery, type RecoveryTmpFs } from "./startup-recovery";
import { fixtureHash, fixtureSessionInput } from "./repository-fixtures";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const HOUR = 3_600_000;

/// 内存版 tmp 目录替身：files 的 value 是 mtime 毫秒；unlink 记录到 removed。
function fakeTmpFs(files: Record<string, number>): RecoveryTmpFs & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    async readdir() {
      return Object.keys(files);
    },
    async stat(path: string) {
      const name = path.split("/").pop() ?? path;
      const mtimeMs = files[name];
      if (mtimeMs === undefined) throw new Error(`ENOENT ${path}`);
      return { mtimeMs };
    },
    async unlink(path: string) {
      const name = path.split("/").pop() ?? path;
      delete files[name];
      removed.push(name);
    },
  };
}

async function repositoryWithEveryStatus() {
  const repo = new InMemoryResearchRepository();
  for (const status of [...NON_TERMINAL_RESEARCH_STATUSES, "completed", "paused", "cancelled", "failed"] as const) {
    await repo.createSession(fixtureSessionInput({ sessionId: `sess-${status}` }));
    await repo.updateSessionStatus(`sess-${status}`, status);
  }
  return repo;
}

describe("runResearchStartupRecovery", () => {
  it("把全部非终态 Session 归一为 interrupted，终态与静止态原样保留", async () => {
    const repo = await repositoryWithEveryStatus();

    const report = await runResearchStartupRecovery({
      repository: repo,
      tmpDir: "/research/tmp",
      tmpFs: fakeTmpFs({}),
      now: NOW,
    });

    expect(report.interruptedSessions.sort()).toEqual(
      NON_TERMINAL_RESEARCH_STATUSES.map((s) => `sess-${s}`).sort(),
    );
    for (const status of NON_TERMINAL_RESEARCH_STATUSES) {
      expect((await repo.getSession(`sess-${status}`, "summary"))?.summary.status).toBe("interrupted");
    }
    for (const status of ["completed", "cancelled", "failed", "paused"] as const) {
      expect((await repo.getSession(`sess-${status}`, "summary"))?.summary.status).toBe(status);
    }
  });

  it("重复执行是幂等的：第二次没有可归一的 Session", async () => {
    const repo = await repositoryWithEveryStatus();
    const deps = { repository: repo, tmpDir: "/research/tmp", tmpFs: fakeTmpFs({}), now: NOW };
    await runResearchStartupRecovery(deps);
    const second = await runResearchStartupRecovery(deps);
    expect(second.interruptedSessions).toEqual([]);
  });

  it("未 committed 的 operation 被标记为可重试（spec §9.1 只重试未提交操作）", async () => {
    const repo = new InMemoryResearchRepository();
    await repo.createSession(fixtureSessionInput());
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-pending",
      kind: "fetch",
      requestPayloadHash: fixtureHash("op1"),
    });
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-done",
      kind: "search",
      requestPayloadHash: fixtureHash("op2"),
    });
    await repo.commitOperation("op-done", () => {});

    const report = await runResearchStartupRecovery({
      repository: repo,
      tmpDir: "/research/tmp",
      tmpFs: fakeTmpFs({}),
      now: NOW,
    });

    expect(report.retryableOperations).toEqual(["op-pending"]);
    expect(await repo.listPendingOperations()).toMatchObject([
      { operationId: "op-pending", retryable: true },
    ]);
  });

  it("清理超过 24 小时的 tmp 文件，但保留新文件与 active operation 的文件", async () => {
    const repo = new InMemoryResearchRepository();
    await repo.createSession(fixtureSessionInput());
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-pending",
      kind: "fetch",
      requestPayloadHash: fixtureHash("op1"),
    });

    const tmpFs = fakeTmpFs({
      "old-garbage.part": NOW.getTime() - 30 * HOUR,
      "fresh.part": NOW.getTime() - 2 * HOUR,
      "op-pending.chunk-3.part": NOW.getTime() - 30 * HOUR,
      "op-gone.part": NOW.getTime() - 30 * HOUR,
    });

    const report = await runResearchStartupRecovery({
      repository: repo,
      tmpDir: "/research/tmp",
      tmpFs,
      now: NOW,
    });

    expect(tmpFs.removed.sort()).toEqual(["old-garbage.part", "op-gone.part"]);
    expect(report.removedTmpFiles).toBe(2);
  });

  it("tmp 目录不存在时不抛错，恢复流程照常完成", async () => {
    const repo = await repositoryWithEveryStatus();
    const failingFs: RecoveryTmpFs = {
      async readdir() {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      async stat() {
        throw new Error("unreachable");
      },
      async unlink() {
        throw new Error("unreachable");
      },
    };

    const report = await runResearchStartupRecovery({
      repository: repo,
      tmpDir: "/research/tmp",
      tmpFs: failingFs,
      now: NOW,
    });
    expect(report.removedTmpFiles).toBe(0);
    expect(report.interruptedSessions).toHaveLength(NON_TERMINAL_RESEARCH_STATUSES.length);
  });

  // 全新安装每次启动都会走这条路；打一条带堆栈的日志纯属噪音，还会被误读成故障。
  it("tmp 目录不存在（ENOENT）不写任何日志：这是全新安装的正常形态", async () => {
    const logged: unknown[][] = [];
    const missingDirFs: RecoveryTmpFs = {
      async readdir() {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      },
      async stat() {
        throw new Error("unreachable");
      },
      async unlink() {
        throw new Error("unreachable");
      },
    };

    await runResearchStartupRecovery({
      repository: await repositoryWithEveryStatus(),
      tmpDir: "/research/tmp",
      tmpFs: missingDirFs,
      now: NOW,
      logger: {
        warn: (...args: unknown[]) => logged.push(["warn", ...args]),
        info: (...args: unknown[]) => logged.push(["info", ...args]),
      },
    });

    expect(logged.filter((entry) => String(entry[1]).includes("tmp 目录"))).toEqual([]);
  });

  it("tmp 目录读取因权限等真实故障失败时记 warn（这类错误不该被静默）", async () => {
    const warnings: unknown[][] = [];
    const deniedFs: RecoveryTmpFs = {
      async readdir() {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
      async stat() {
        throw new Error("unreachable");
      },
      async unlink() {
        throw new Error("unreachable");
      },
    };

    const report = await runResearchStartupRecovery({
      repository: await repositoryWithEveryStatus(),
      tmpDir: "/research/tmp",
      tmpFs: deniedFs,
      now: NOW,
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
    });

    expect(report.removedTmpFiles).toBe(0);
    expect(warnings.some((args) => String(args[0]).includes("tmp 目录"))).toBe(true);
  });

  it("单条 Session 归一失败不会中断整体恢复，错误记入 logger", async () => {
    const repo = await repositoryWithEveryStatus();
    const failing = Object.create(repo) as InMemoryResearchRepository;
    failing.updateSessionStatus = async (sessionId, status, errorMessage, updatedAt) => {
      if (sessionId === "sess-searching") throw new Error("磁盘只读");
      await InMemoryResearchRepository.prototype.updateSessionStatus.call(
        repo,
        sessionId,
        status,
        errorMessage,
        updatedAt,
      );
    };
    const warnings: unknown[][] = [];

    const report = await runResearchStartupRecovery({
      repository: failing,
      tmpDir: "/research/tmp",
      tmpFs: fakeTmpFs({}),
      now: NOW,
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
    });

    expect(report.interruptedSessions).not.toContain("sess-searching");
    expect(report.interruptedSessions).toHaveLength(NON_TERMINAL_RESEARCH_STATUSES.length - 1);
    expect(warnings).toHaveLength(1);
  });
});
