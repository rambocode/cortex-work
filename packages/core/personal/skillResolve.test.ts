// resolveEnabledSkillPaths（U5）单测:过滤禁用/未授信、name 去重(全局覆盖工作区)、
// useOwnSkills 一键关、bridge 缺失降级。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import type { PersistedState, PiSkillSettings, PluginSkill } from "../desktop/types";
import type { PiExtensionSettings, InstalledExtensionRecord } from "../desktop/types";
import { DEFAULT_GENERAL_SETTINGS, DEFAULT_PI_SKILLS, DEFAULT_PI_EXTENSIONS } from "../desktop/types";
import { usePersonalStore } from "../store/personal";
import { resolveEnabledSkillPaths, resolveEnabledExtensionPaths } from "./messages";

const base: PersistedState = { version: 1, projects: [], sessions: [] };

function setPiSkills(patch: Partial<PiSkillSettings>): void {
  usePersonalStore.getState().hydrate({
    ...base,
    generalSettings: { ...DEFAULT_GENERAL_SETTINGS, piSkills: { ...DEFAULT_PI_SKILLS, ...patch } },
  });
}

function skill(name: string, scope: "global" | "workspace", dir: string): PluginSkill {
  return { name, description: "", dir, rootPath: "/root", scope, enabled: true, trusted: scope === "global" };
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
