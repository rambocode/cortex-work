import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DelegationBudgetGuard,
  delegationContractSchema,
  renderDelegationContract,
  repositoryDelegationContractSchema,
  validateDelegationTarget,
  type DelegationContract,
} from "./contract";

const tempDirs: string[] = [];

function contract(overrides: Partial<DelegationContract> = {}): DelegationContract {
  return {
    title: "Project structure",
    objective: "Explain the repository's top-level modules and ownership.",
    target: {
      description: "Cortex Desktop repository",
      rootPath: "/workspace/cortex-work",
      paths: ["apps", "packages"],
    },
    inScope: ["Identify top-level module responsibilities", "Cite authoritative files"],
    outOfScope: ["Do not modify files", "Do not inspect directories outside the target root"],
    constraints: {
      maxToolCalls: 12,
      maxDurationMinutes: 5,
      additional: ["Ignore generated build output"],
    },
    context: ["The repository is a pnpm monorepo."],
    deliverable: "A concise module map with file-path evidence.",
    doneWhen: ["Every top-level source directory has an explained responsibility"],
    blockedWhen: ["The target root is missing, empty, or unreadable"],
    ...overrides,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("delegation contract", () => {
  it("requires every goal, scope, boundary, output, completion, and blocker field", () => {
    const parsed = delegationContractSchema.safeParse({ title: "Incomplete" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const paths = parsed.error.issues.map((issue) => issue.path.join("."));
    expect(paths).toEqual(expect.arrayContaining([
      "objective",
      "target",
      "inScope",
      "outOfScope",
      "constraints",
      "context",
      "deliverable",
      "doneWhen",
      "blockedWhen",
    ]));
  });

  it("Repository Explorer rejects a relative root before the child can run", () => {
    const parsed = repositoryDelegationContractSchema.safeParse(
      contract({ target: { description: "repo", rootPath: "../guessed-repo", paths: [] } }),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(["target", "rootPath"]);
  });

  it("renders one authoritative child prompt and derives access from the role", () => {
    const prompt = renderDelegationContract(contract(), {
      access: "readOnly",
      roleLabel: "Repository Explorer",
    });
    expect(prompt).toContain("<delegation_contract>");
    expect(prompt).toContain('"objective": "Explain the repository\'s top-level modules and ownership."');
    expect(prompt).toContain('"inScope"');
    expect(prompt).toContain('"outOfScope"');
    expect(prompt).toContain('"doneWhen"');
    expect(prompt).toContain('"blockedWhen"');
    expect(prompt).toContain("Read-only. Runtime tools physically prevent workspace mutation.");
    expect(prompt).toContain("Do not guess missing targets, walk parent/home directories");
  });

  it("rejects an empty repository root and target paths that escape it", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-delegate-contract-"));
    tempDirs.push(root);
    const empty = contract({ target: { description: "empty repo", rootPath: root, paths: [] } });
    await expect(validateDelegationTarget(empty, {
      requireRootPath: true,
      requireNonEmptyRoot: true,
    })).resolves.toContain("是空目录");

    await writeFile(join(root, "README.md"), "# Fixture", "utf8");
    const escaped = contract({ target: { description: "repo", rootPath: root, paths: ["../secret"] } });
    await expect(validateDelegationTarget(escaped, {
      requireRootPath: true,
      requireNonEmptyRoot: true,
    })).resolves.toContain("越出 target.rootPath");

    const valid = contract({ target: { description: "repo", rootPath: root, paths: ["README.md"] } });
    await expect(validateDelegationTarget(valid, {
      requireRootPath: true,
      requireNonEmptyRoot: true,
    })).resolves.toBeNull();
  });

  it("rejects a contract whose rendered prompt would consume an unsafe amount of context", () => {
    const oversized = contract({ context: ["A".repeat(12_000), "B".repeat(12_000), "C".repeat(12_000)] });
    expect(() => renderDelegationContract(oversized, {
      access: "inherit",
      roleLabel: "General Agent",
    })).toThrow("委派合同过长");
  });
});

describe("DelegationBudgetGuard", () => {
  it("hard-stops on the first tool call beyond the contract limit", () => {
    const guard = new DelegationBudgetGuard({ maxToolCalls: 2, maxDurationMinutes: 5, additional: [] });
    expect(guard.recordToolCall()).toBeUndefined();
    expect(guard.recordToolCall()).toBeUndefined();
    expect(guard.recordToolCall()).toMatchObject({
      kind: "tool-call-limit",
      limit: 2,
      observed: 3,
    });
    guard.dispose();
  });

  it("hard-stops when the contract duration expires", async () => {
    vi.useFakeTimers();
    const onTrip = vi.fn();
    const guard = new DelegationBudgetGuard({ maxToolCalls: 10, maxDurationMinutes: 1, additional: [] });
    guard.start(onTrip);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onTrip).toHaveBeenCalledWith(expect.objectContaining({ kind: "duration-limit", limit: 1 }));
    guard.dispose();
  });
});
