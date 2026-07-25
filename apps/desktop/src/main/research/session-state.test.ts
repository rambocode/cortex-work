// 状态推进守卫的测试：合法转移落库、非法转移抛错、终态多跳收敛。
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryResearchRepository } from "./repository-memory";
import { fixtureSessionInput } from "./repository-fixtures";
import { IllegalStatusTransitionError, SessionStateWriter, resolveStatusPath } from "./session-state";

const SESSION_ID = "sess-1";

describe("resolveStatusPath", () => {
  it("直达边返回单步路径", () => {
    expect(resolveStatusPath("created", "planning")).toEqual(["planning"]);
  });

  it("paused 到 cancelled 需要多跳（状态图无直达边）", () => {
    const path = resolveStatusPath("paused", "cancelled")!;
    expect(path.length).toBeGreaterThan(1);
    expect(path.at(-1)).toBe("cancelled");
  });

  it("终态出不去", () => {
    expect(resolveStatusPath("completed", "planning")).toBeNull();
  });
});

describe("SessionStateWriter", () => {
  let repository: InMemoryResearchRepository;

  beforeEach(async () => {
    repository = new InMemoryResearchRepository();
    await repository.createSession(fixtureSessionInput({ sessionId: SESSION_ID }));
  });

  it("合法转移写库并更新内存状态", async () => {
    const writer = new SessionStateWriter(repository, SESSION_ID, "created");
    await writer.to("planning");
    expect(writer.current).toBe("planning");
    expect((await repository.getSession(SESSION_ID, "summary"))?.summary.status).toBe("planning");
  });

  it("非法转移抛错且不写库", async () => {
    const writer = new SessionStateWriter(repository, SESSION_ID, "created");
    await expect(writer.to("completed")).rejects.toBeInstanceOf(IllegalStatusTransitionError);
    expect((await repository.getSession(SESSION_ID, "summary"))?.summary.status).toBe("created");
  });

  it("forceTo 经合法多跳收敛到终态，错误文案只落在终点", async () => {
    await repository.updateSessionStatus(SESSION_ID, "paused");
    const writer = new SessionStateWriter(repository, SESSION_ID, "paused");
    await writer.forceTo("cancelled", "用户取消");

    const summary = (await repository.getSession(SESSION_ID, "summary"))!.summary;
    expect(summary.status).toBe("cancelled");
    expect(summary.errorMessage).toBe("用户取消");
  });
});
