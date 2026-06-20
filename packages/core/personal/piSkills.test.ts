// usePiEnabledSkills 的纯过滤逻辑单测(U3,node 环境)。hook 的桥 / 门控 / 降级 DOM 行为由
// views 侧 PersonalComposer.test.tsx 覆盖(遵 core「只测纯函数」约定)。
import { describe, expect, it } from "vitest";
import { DEFAULT_PI_SKILLS, type PiSkillSettings, type PluginSkill } from "../desktop/types";
import { filterEnabledPiSkills } from "./piSkills";

function sk(name: string, scope: "global" | "workspace", dir: string, argumentHint?: string): PluginSkill {
  return { name, description: `${name} 描述`, dir, rootPath: "/root", scope, enabled: true, trusted: scope === "global", argumentHint, docs: [] };
}

function cfg(over: Partial<PiSkillSettings> = {}): PiSkillSettings {
  return { ...DEFAULT_PI_SKILLS, ...over };
}

describe("filterEnabledPiSkills", () => {
  it("禁用项(scope:name)被过滤,其余保留(R3)", () => {
    const out = filterEnabledPiSkills(
      [sk("code-review", "global", "/g/cr"), sk("bug-hunt", "global", "/g/bh")],
      cfg({ disabledSkills: ["global:code-review"] }),
    );
    expect(out.map((s) => s.name)).toEqual(["bug-hunt"]);
  });

  it("工作区未授信 skill 不出现(与注入一致)", () => {
    const out = filterEnabledPiSkills(
      [sk("ws", "workspace", "/proj/.cortex-desktop/skills/ws")],
      cfg(), // trustedWorkspaceSkillDirs 为空 → 未授信
    );
    expect(out).toEqual([]);
  });

  it("工作区已授信 skill 出现", () => {
    const out = filterEnabledPiSkills(
      [sk("ws", "workspace", "/proj/.cortex-desktop/skills/ws")],
      cfg({ trustedWorkspaceSkillDirs: ["/proj/.cortex-desktop/skills/ws"] }),
    );
    expect(out.map((s) => s.name)).toEqual(["ws"]);
  });

  it("同名全局+工作区 → 全局覆盖(防工作区同名劫持)", () => {
    const out = filterEnabledPiSkills(
      [sk("dup", "global", "/g/dup"), sk("dup", "workspace", "/proj/.cortex-desktop/skills/dup")],
      cfg({ trustedWorkspaceSkillDirs: ["/proj/.cortex-desktop/skills/dup"] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("dup");
    expect(out[0]?.description).toBe("dup 描述"); // 全局项的元数据
  });

  it("携带 argumentHint(供 argHint 展示),按 name 排序", () => {
    const out = filterEnabledPiSkills(
      [sk("zeta", "global", "/g/z"), sk("agent-browser", "global", "/g/ab", "<url>")],
      cfg(),
    );
    expect(out.map((s) => s.name)).toEqual(["agent-browser", "zeta"]); // localeCompare 排序
    expect(out[0]?.argumentHint).toBe("<url>");
  });

  it("空输入 → 空数组(R7 降级路径的纯函数侧)", () => {
    expect(filterEnabledPiSkills([], cfg())).toEqual([]);
  });
});
