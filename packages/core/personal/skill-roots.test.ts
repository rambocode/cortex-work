import { describe, expect, it } from "vitest";
import { DEFAULT_PI_SKILLS, type PiSkillSettings } from "../desktop/types";
import { resolveAgentSkillRoots } from "./skill-roots";

// 基准 cfg:默认原生根 + 默认共享根 + 一个用户自增共享根 + 一个 claude 私有自增根。
const cfg: PiSkillSettings = {
  ...DEFAULT_PI_SKILLS,
  // ~/.agents/skills 为跨 agent 标准目录 → 共享(三端)。
  sharedRoots: ["~/.cortex-desktop/skills", "~/.agents/skills", "~/shared-extra"],
  agentRoots: {
    claude: ["~/.claude/skills", "~/claude-extra"],
    codex: ["~/.codex/skills"],
    pi: ["~/.pi/agent/skills"],
  },
};

describe("resolveAgentSkillRoots（Design B, plan 002 U2）", () => {
  it("claude + 项目 + workspaceEnabled → 共享全局 + claude 私有全局 + 共享/claude 工作区", () => {
    const roots = resolveAgentSkillRoots(cfg, "claude", "/proj");
    expect(roots).toEqual([
      { path: "~/.cortex-desktop/skills", scope: "global", origin: "shared" },
      { path: "~/.agents/skills", scope: "global", origin: "shared" },
      { path: "~/shared-extra", scope: "global", origin: "shared" },
      { path: "~/.claude/skills", scope: "global", origin: "agent" },
      { path: "~/claude-extra", scope: "global", origin: "agent" },
      { path: ".cortex-desktop/skills", scope: "workspace", origin: "shared" },
      { path: ".agents/skills", scope: "workspace", origin: "shared" },
      { path: ".claude/skills", scope: "workspace", origin: "agent" },
    ]);
  });

  it("pi → 私有全局仅 ~/.pi/agent/skills(工作区 .pi/skills);~/.agents/skills 归共享", () => {
    const roots = resolveAgentSkillRoots(cfg, "pi", "/proj");
    const agentGlobal = roots.filter((r) => r.scope === "global" && r.origin === "agent").map((r) => r.path);
    expect(agentGlobal).toEqual(["~/.pi/agent/skills"]);
    const agentWs = roots.filter((r) => r.scope === "workspace" && r.origin === "agent").map((r) => r.path);
    expect(agentWs).toEqual([".pi/skills"]);
    // ~/.agents/skills 与项目 .agents/skills 都是共享,pi 也能看到(与 claude/codex 一致)。
    const shared = roots.filter((r) => r.origin === "shared").map((r) => r.path);
    expect(shared).toContain("~/.agents/skills");
    expect(shared).toContain(".agents/skills");
  });

  it("codex → 私有全局含 ~/.codex/skills;工作区含 .codex/skills", () => {
    const roots = resolveAgentSkillRoots(cfg, "codex", "/proj");
    const agentGlobal = roots.filter((r) => r.scope === "global" && r.origin === "agent").map((r) => r.path);
    expect(agentGlobal).toEqual(["~/.codex/skills"]);
    const agentWs = roots.filter((r) => r.scope === "workspace" && r.origin === "agent").map((r) => r.path);
    expect(agentWs).toEqual([".codex/skills"]);
  });

  it("无 projectPath → 不产出任何 workspace scope 根", () => {
    const roots = resolveAgentSkillRoots(cfg, "claude", undefined);
    expect(roots.every((r) => r.scope === "global")).toBe(true);
  });

  it("workspaceEnabled=false → 即使有 projectPath 也不产出 workspace 根", () => {
    const roots = resolveAgentSkillRoots({ ...cfg, workspaceEnabled: false }, "pi", "/proj");
    expect(roots.every((r) => r.scope === "global")).toBe(true);
  });

  it("共享根始终在前、agent 私有根在后(scanSkillRoots 稳定顺序)", () => {
    const roots = resolveAgentSkillRoots(cfg, "claude", undefined);
    const firstAgentIdx = roots.findIndex((r) => r.origin === "agent");
    const lastSharedIdx = roots.map((r) => r.origin).lastIndexOf("shared");
    expect(lastSharedIdx).toBeLessThan(firstAgentIdx);
  });

  it("agent 缺省 → 只产出共享根(无 agent 私有根,防串场)", () => {
    const roots = resolveAgentSkillRoots(cfg, undefined, "/proj");
    expect(roots.every((r) => r.origin === "shared")).toBe(true);
    expect(roots.some((r) => r.scope === "global")).toBe(true);
    expect(roots.some((r) => r.scope === "workspace")).toBe(true);
  });

  it("空 agentRoots[agent] → 只产出共享根,不报错", () => {
    const empty: PiSkillSettings = { ...cfg, agentRoots: { claude: [], codex: [], pi: [] } };
    const roots = resolveAgentSkillRoots(empty, "claude", "/proj");
    expect(roots.filter((r) => r.origin === "agent").filter((r) => r.scope === "global")).toEqual([]);
    // 共享全局 + 共享工作区仍在
    expect(roots.some((r) => r.origin === "shared" && r.scope === "global")).toBe(true);
    expect(roots.some((r) => r.origin === "shared" && r.scope === "workspace")).toBe(true);
  });
});
