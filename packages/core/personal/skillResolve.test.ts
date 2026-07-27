// resolveEnabledSkillPaths（U5）单测:过滤禁用/未授信、name 去重(全局覆盖工作区)、
// useOwnSkills 一键关、bridge 缺失降级。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import type { PersistedState, PiSkillSettings, PluginSkill } from "../desktop/types";
import type { PiExtensionSettings, InstalledExtensionRecord } from "../desktop/types";
import { DEFAULT_GENERAL_SETTINGS, DEFAULT_PI_SKILLS, DEFAULT_PI_EXTENSIONS } from "../desktop/types";
import { usePersonalStore } from "../store/personal";
import { resolveEnabledSkillPaths, resolveEnabledExtensionPaths } from "./messages";
import { resolveEnabledSkillRecords } from "./skill-injection";
import * as skillInjection from "./skill-injection";

const base: PersistedState = { version: 1, projects: [], sessions: [] };

function setPiSkills(patch: Partial<PiSkillSettings>): void {
  usePersonalStore.getState().hydrate({
    ...base,
    generalSettings: { ...DEFAULT_GENERAL_SETTINGS, piSkills: { ...DEFAULT_PI_SKILLS, ...patch } },
  });
}

function skill(name: string, scope: "global" | "workspace", dir: string): PluginSkill {
  return { name, description: "", dir, rootPath: "/root", scope, enabled: true, trusted: scope === "global", docs: [] };
}

function bridgeWith(skills: PluginSkill[]): DesktopBridge {
  return { piSkillsList: vi.fn(async () => skills) } as unknown as DesktopBridge;
}

beforeEach(() => setPiSkills({}));

describe("resolveEnabledSkillPaths", () => {
  it("全局全启用 → 返回排序后的 dir", async () => {
    const bridge = bridgeWith([skill("b", "global", "/g/b"), skill("a", "global", "/g/a")]);
    expect(await resolveEnabledSkillPaths(bridge, "/proj", undefined)).toEqual(["/g/a", "/g/b"]);
  });

  it("禁用集(scope:name)排除对应项", async () => {
    setPiSkills({ disabledSkills: ["global:a"] });
    const bridge = bridgeWith([skill("a", "global", "/g/a"), skill("b", "global", "/g/b")]);
    expect(await resolveEnabledSkillPaths(bridge, "/proj", undefined)).toEqual(["/g/b"]);
  });

  it("工作区 skill 未授信不注入；授信后注入", async () => {
    const ws = skill("w", "workspace", "/proj/.cortex-desktop/skills/w");
    const bridge = bridgeWith([ws]);
    expect(await resolveEnabledSkillPaths(bridge, "/proj", undefined)).toEqual([]);
    setPiSkills({ trustedWorkspaceSkillDirs: [ws.dir] });
    expect(await resolveEnabledSkillPaths(bridge, "/proj", undefined)).toEqual([ws.dir]);
  });

  it("同名全局+工作区(已授信) → 仅全局 dir(全局覆盖工作区)", async () => {
    const ws = skill("dup", "workspace", "/proj/.cortex-desktop/skills/dup");
    setPiSkills({ trustedWorkspaceSkillDirs: [ws.dir] });
    const bridge = bridgeWith([ws, skill("dup", "global", "/g/dup")]);
    expect(await resolveEnabledSkillPaths(bridge, "/proj", undefined)).toEqual(["/g/dup"]);
  });

  it("useOwnSkills===false → 会话级一键关,返回 []", async () => {
    const bridge = bridgeWith([skill("a", "global", "/g/a")]);
    expect(await resolveEnabledSkillPaths(bridge, "/proj", false)).toEqual([]);
  });

  it("bridge 无 piSkillsList(web/旧壳) → 降级 []", async () => {
    expect(await resolveEnabledSkillPaths({} as DesktopBridge, "/proj", undefined)).toEqual([]);
  });

  it("piSkillsList 抛错 → 降级 [] 不阻断", async () => {
    const bridge = { piSkillsList: vi.fn(async () => { throw new Error("boom"); }) } as unknown as DesktopBridge;
    expect(await resolveEnabledSkillPaths(bridge, "/proj", undefined)).toEqual([]);
  });

  // U6 去重(KTD5):useOwnSkills===true 时 pi 放开原生发现(d1a0bec),剔除 origin==="agent" 的 --skill;
  // useOwnSkills!==true(原生关)时保留全部,否则 agent 原生根 skill 丢失。
  it("useOwnSkills===true:剔除 agent 原生根 skill(pi 自发现),保留共享根", async () => {
    const agentSkill: PluginSkill = { ...skill("na", "global", "/pi/na"), origin: "agent" };
    const sharedSkill: PluginSkill = { ...skill("sh", "global", "/shared/sh"), origin: "shared" };
    const bridge = bridgeWith([agentSkill, sharedSkill]);
    expect(await resolveEnabledSkillPaths(bridge, "/proj", true, "pi")).toEqual(["/shared/sh"]);
  });

  it("useOwnSkills===undefined(原生关):保留 agent 原生根 skill(否则丢失)", async () => {
    const agentSkill: PluginSkill = { ...skill("na", "global", "/pi/na"), origin: "agent" };
    const sharedSkill: PluginSkill = { ...skill("sh", "global", "/shared/sh"), origin: "shared" };
    const bridge = bridgeWith([agentSkill, sharedSkill]);
    expect((await resolveEnabledSkillPaths(bridge, "/proj", undefined, "pi")).sort()).toEqual(["/pi/na", "/shared/sh"]);
  });
});

// resolveEnabledSkillRecords(U2):claude/codex prose 注入的记录源。与 resolveEnabledSkillPaths
// 共用同一过滤链(后者已覆盖过滤/去重/降级),此处验证记录形状与 useOwnSkills 短路(RISK-2)。
describe("resolveEnabledSkillRecords", () => {
  it("返回含 name/description/dir 的记录,按 dir 排序", async () => {
    const a: PluginSkill = { ...skill("alpha", "global", "/g/alpha"), description: "做 A" };
    const b: PluginSkill = { ...skill("beta", "global", "/g/beta"), description: "做 B" };
    const bridge = bridgeWith([b, a]);
    expect(await resolveEnabledSkillRecords(bridge, "/proj", undefined)).toEqual([
      { name: "alpha", description: "做 A", dir: "/g/alpha" },
      { name: "beta", description: "做 B", dir: "/g/beta" },
    ]);
  });

  it("useOwnSkills===false → [](会话级一键关对 claude/codex 同样生效,RISK-2)", async () => {
    const bridge = bridgeWith([skill("a", "global", "/g/a")]);
    expect(await resolveEnabledSkillRecords(bridge, "/proj", false)).toEqual([]);
  });

  it("禁用 + 工作区未授信均被剔除(记录路径)", async () => {
    setPiSkills({ disabledSkills: ["global:a"] });
    const ws = skill("w", "workspace", "/proj/.cortex-desktop/skills/w");
    const bridge = bridgeWith([skill("a", "global", "/g/a"), skill("b", "global", "/g/b"), ws]);
    const dirs = (await resolveEnabledSkillRecords(bridge, "/proj", undefined)).map((s) => s.dir);
    expect(dirs).toEqual(["/g/b"]);
  });

  it("supportedAgents 过滤(U5):声明 [pi] 的 skill 对 claude 不注入,对 pi / 不传 agent 注入", async () => {
    const piOnly: PluginSkill = { ...skill("pi-only", "global", "/g/pi-only"), supportedAgents: ["pi"] };
    const uni = skill("uni", "global", "/g/uni"); // 无声明 = 全 agent
    const bridge = bridgeWith([piOnly, uni]);
    const dirs = async (agent?: "claude" | "codex" | "pi") =>
      (await resolveEnabledSkillRecords(bridge, "/proj", undefined, agent)).map((s) => s.dir);
    expect(await dirs("claude")).toEqual(["/g/uni"]); // pi-only 被过滤
    expect(await dirs("pi")).toEqual(["/g/pi-only", "/g/uni"]); // 两者
    expect(await dirs()).toEqual(["/g/pi-only", "/g/uni"]); // 不传 agent → 不过滤
  });

  // Design B(plan 002 U4):注入解析按 agent 传不同 rootSpecs(与下拉共用 resolveAgentSkillRoots)。
  it("按 agent 传不同 rootSpecs 给 piSkillsList(与下拉同源)", async () => {
    const fn = vi.fn(async (_args: { rootSpecs: { path: string }[] }) => [] as PluginSkill[]);
    const bridge = { piSkillsList: fn } as unknown as DesktopBridge;
    await resolveEnabledSkillRecords(bridge, "/proj", undefined, "claude");
    const claudePaths = fn.mock.calls[0]![0].rootSpecs.map((r) => r.path);
    expect(claudePaths).toContain("~/.claude/skills");
    expect(claudePaths).not.toContain("~/.pi/agent/skills");
    fn.mockClear();
    await resolveEnabledSkillRecords(bridge, "/proj", undefined, "pi");
    const piPaths = fn.mock.calls[0]![0].rootSpecs.map((r) => r.path);
    expect(piPaths).toContain("~/.pi/agent/skills");
    expect(piPaths).not.toContain("~/.claude/skills");
  });

  it("origin 从 PluginSkill 透传到记录(供 U6 去重)", async () => {
    const agentSkill: PluginSkill = { ...skill("x", "global", "/g/x"), origin: "agent" };
    const sharedSkill: PluginSkill = { ...skill("y", "global", "/g/y"), origin: "shared" };
    const bridge = bridgeWith([agentSkill, sharedSkill]);
    const recs = await resolveEnabledSkillRecords(bridge, "/proj", undefined, "pi");
    expect(recs.find((r) => r.dir === "/g/x")?.origin).toBe("agent");
    expect(recs.find((r) => r.dir === "/g/y")?.origin).toBe("shared");
  });
});

describe("会话产物上下文规划", () => {
  it("同类型复用当前产物,无产物或类型变化时创建新产物", () => {
    expect(skillInjection).toHaveProperty("resolveArtifactTarget");
    const resolveArtifactTarget = (
      skillInjection as unknown as {
        resolveArtifactTarget: (
          kind: "design" | "slides",
          current?: { kind: "design" | "slides"; documentId: string },
        ) => { mode: "create" | "edit"; artifact?: { documentId: string } };
      }
    ).resolveArtifactTarget;
    const design = { kind: "design" as const, documentId: "d1" };

    expect(resolveArtifactTarget("design")).toEqual({ mode: "create" });
    expect(resolveArtifactTarget("design", design)).toEqual({ mode: "edit", artifact: design });
    expect(resolveArtifactTarget("slides", design)).toEqual({ mode: "create" });
  });
});

// resolveEnabledExtensionPaths（U3）:仅 enabled∩trusted 的 global 已装扩展注入 -e;装≠启用、信任门。
function setPiExt(patch: Partial<PiExtensionSettings>): void {
  usePersonalStore.getState().hydrate({
    ...base,
    generalSettings: { ...DEFAULT_GENERAL_SETTINGS, piExtensions: { ...DEFAULT_PI_EXTENSIONS, ...patch } },
  });
}
function extRec(ref: string, path: string): InstalledExtensionRecord {
  return { ref, scope: "global", sourceRef: ref, origin: ref.split(":")[0] ?? "npm", installedAt: 1, path };
}

describe("resolveEnabledExtensionPaths", () => {
  it("仅 enabled 且 trusted 的扩展注入路径", () => {
    setPiExt({
      installed: [extRec("npm:a", "/e/a"), extRec("npm:b", "/e/b")],
      enabled: ["global:npm:a", "global:npm:b"],
      trusted: ["global:npm:a"], // b 未过信任门
    });
    expect(resolveEnabledExtensionPaths("/proj")).toEqual(["/e/a"]);
  });

  it("已装未启用 → 不注入（装≠启用）", () => {
    setPiExt({ installed: [extRec("npm:a", "/e/a")], enabled: [], trusted: ["global:npm:a"] });
    expect(resolveEnabledExtensionPaths("/proj")).toEqual([]);
  });

  it("禁用先前启用项 → 路径消失（防裸奔的解析侧）", () => {
    setPiExt({ installed: [extRec("npm:a", "/e/a")], enabled: ["global:npm:a"], trusted: ["global:npm:a"] });
    expect(resolveEnabledExtensionPaths("/proj")).toEqual(["/e/a"]);
    setPiExt({ installed: [extRec("npm:a", "/e/a")], enabled: [], trusted: ["global:npm:a"] });
    expect(resolveEnabledExtensionPaths("/proj")).toEqual([]);
  });

  it("多项排序去重", () => {
    setPiExt({
      installed: [extRec("npm:b", "/e/b"), extRec("npm:a", "/e/a")],
      enabled: ["global:npm:a", "global:npm:b"],
      trusted: ["global:npm:a", "global:npm:b"],
    });
    expect(resolveEnabledExtensionPaths("/proj")).toEqual(["/e/a", "/e/b"]);
  });
});
