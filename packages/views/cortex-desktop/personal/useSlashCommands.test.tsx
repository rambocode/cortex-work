// slash 命令组装的门控测试。
//
// 这里守的是**两类系统 skill 的门控互不相同**这条容易改错的规则：
// 产物类（设计稿 / 演示文稿）走 agent 一轮对话，受会话级「skills」开关约束；
// 深度研究不经 agent（活由 CRE 引擎干），所以只看研究引擎自己的三个条件。
// 把研究也挂到 useOwnSkills 上，用户一关 skills 就会连研究入口一起消失——
// 那是两件毫不相干的事。
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CoreProvider, usePersonalStore, type DesktopBridge, type SessionMeta } from "@cortex-work/core";
import type { ReactNode } from "react";

import { RESEARCH_SKILL_CMD, useSlashCommands } from "./useSlashCommands";

const SESSION: SessionMeta = {
  id: "s1",
  projectId: "p1",
  title: "Session 1",
  agent: "claude",
  createdAt: 1,
  updatedAt: 1,
};

/// 带 research 子域的桥。piSkillsList 刻意不给：本组只关心系统 skill 的门控，
/// 用户自己的 skill 列表恒为空即可。
const RESEARCH_BRIDGE = { research: {} } as unknown as DesktopBridge;

function wrapper(bridge: DesktopBridge | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
          {children}
        </CoreProvider>
      </QueryClientProvider>
    );
  };
}

function setResearchEngine(patch: Record<string, unknown> | undefined): void {
  usePersonalStore.setState((s) => ({
    generalSettings: { ...s.generalSettings, researchEngine: patch as never },
  }));
}

function cmdsWith(bridge: DesktopBridge | null, session: SessionMeta | undefined = SESSION): string[] {
  const { result } = renderHook(() => useSlashCommands(session), { wrapper: wrapper(bridge) });
  return result.current.map((c) => c.cmd);
}

beforeEach(() => setResearchEngine(undefined));

describe("深度研究 slash 项的门控", () => {
  it("无桥（Web 端）时不出现", () => {
    setResearchEngine({ enabled: true, deepResearchEnabled: true });
    expect(cmdsWith(null)).not.toContain(RESEARCH_SKILL_CMD);
  });

  it("研究引擎总开关关着时不出现", () => {
    setResearchEngine({ enabled: false, deepResearchEnabled: true });
    expect(cmdsWith(RESEARCH_BRIDGE)).not.toContain(RESEARCH_SKILL_CMD);
  });

  /// 总开关开着但深度研究这一档关掉时，后端会直接拒绝发起——菜单里留着就是个死入口。
  it("深度研究档关着时不出现", () => {
    setResearchEngine({ enabled: true, deepResearchEnabled: false });
    expect(cmdsWith(RESEARCH_BRIDGE)).not.toContain(RESEARCH_SKILL_CMD);
  });

  it("三个条件齐全时出现", () => {
    setResearchEngine({ enabled: true, deepResearchEnabled: true });
    expect(cmdsWith(RESEARCH_BRIDGE)).toContain(RESEARCH_SKILL_CMD);
  });
});

describe("系统 skill 与会话级 skills 开关", () => {
  it("关掉 skills：产物类消失，深度研究仍在（两者门控不同源）", () => {
    setResearchEngine({ enabled: true, deepResearchEnabled: true });
    const cmds = cmdsWith(RESEARCH_BRIDGE, { ...SESSION, useOwnSkills: false });
    expect(cmds).not.toContain("/skill:design");
    expect(cmds).not.toContain("/skill:slides");
    expect(cmds).toContain(RESEARCH_SKILL_CMD);
  });

  it("开着 skills：三个系统 skill 都在", () => {
    setResearchEngine({ enabled: true, deepResearchEnabled: true });
    const cmds = cmdsWith(RESEARCH_BRIDGE, { ...SESSION, useOwnSkills: true });
    expect(cmds).toEqual(expect.arrayContaining(["/skill:design", "/skill:slides", RESEARCH_SKILL_CMD]));
  });
});
