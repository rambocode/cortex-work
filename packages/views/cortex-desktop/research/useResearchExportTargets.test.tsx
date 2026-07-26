// 研究产物去向的测试。
//
// 关键约定：**能力缺失时不给按钮**（与研究 MCP 注入的 gate 同一条原则）——
// 一个点了必然失败的「存为写作文档」比没有这个按钮更糟。
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CoreProvider, usePersonalStore, type DesktopBridge } from "@cortex-work/core";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import type { ResearchSessionSummary } from "@cortex-work/core/research/types";
import type { ReactNode } from "react";

import {
  researchFileBaseName,
  useResearchExportTargets,
  withResearchHeader,
} from "./useResearchExportTargets";

const SESSION: ResearchSessionSummary = {
  sessionId: "ses-1",
  consumer: "deep_research",
  objective: "调研向量数据库选型",
  mode: "standard",
  status: "completed",
  createdAt: "2026-07-26T00:00:00Z",
  updatedAt: "2026-07-26T00:00:00Z",
  roundCount: 3,
  documentCount: 12,
  chunkCount: 40,
};

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

function setSpace(root: string | null): void {
  useWritingSpacesStore.setState(
    root
      ? { spaces: [{ id: "sp-1", name: "空间", root }], activeSpaceId: "sp-1" }
      : { spaces: [], activeSpaceId: null },
  );
}

beforeEach(() => setSpace(null));

describe("researchFileBaseName", () => {
  it("用研究目标当文件名", () => {
    expect(researchFileBaseName(SESSION)).toBe("调研向量数据库选型");
  });

  it("剔除路径分隔符与 Windows 保留字符（目标是用户自由输入的一句话）", () => {
    const name = researchFileBaseName({ ...SESSION, objective: 'a/b\\c:d*e?f"g<h>i|j' });
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it("超长目标截到 40 字（完整目标做文件名在文件树里没法看）", () => {
    const name = researchFileBaseName({ ...SESSION, objective: "长".repeat(200) });
    expect([...name]).toHaveLength(40);
  });

  it("空目标回落 sessionId（永远要有个名字）", () => {
    expect(researchFileBaseName({ ...SESSION, objective: "   " })).toBe("research-ses-1");
  });
});

describe("withResearchHeader", () => {
  it("加来源抬头，让产物离开研究模块后仍认得出出处", () => {
    const out = withResearchHeader("# 报告", SESSION);
    expect(out).toContain("来自 Cortex 深度研究");
    expect(out).toContain(SESSION.objective);
    expect(out).toContain(SESSION.sessionId);
    expect(out).toContain("# 报告");
  });
});

describe("useResearchExportTargets 能力门控", () => {
  it("没有桥时一个去向都不给", () => {
    const { result } = renderHook(() => useResearchExportTargets(), { wrapper: wrapper(null) });
    expect(result.current).toEqual([]);
  });

  it("没有写作空间时不给「存为写作文档」", () => {
    const bridge = { writeFile: vi.fn() } as unknown as DesktopBridge;
    const { result } = renderHook(() => useResearchExportTargets(), { wrapper: wrapper(bridge) });
    expect(result.current.map((t) => t.id)).not.toContain("writing");
  });

  it("桥不支持闪记时不给「存为闪记」", () => {
    setSpace("/tmp/space");
    const bridge = { writeFile: vi.fn() } as unknown as DesktopBridge;
    const { result } = renderHook(() => useResearchExportTargets(), { wrapper: wrapper(bridge) });
    expect(result.current.map((t) => t.id)).toEqual(["writing"]);
  });

  it("能力齐全时两个去向都给", () => {
    setSpace("/tmp/space");
    const bridge = { writeFile: vi.fn(), notesAdd: vi.fn() } as unknown as DesktopBridge;
    const { result } = renderHook(() => useResearchExportTargets(), { wrapper: wrapper(bridge) });
    expect(result.current.map((t) => t.id)).toEqual(["writing", "note"]);
  });
});

describe("存为写作文档", () => {
  it("写进当前空间根目录，文件名取自研究目标，正文带来源抬头", async () => {
    setSpace("/tmp/space");
    const writeFile = vi.fn(async () => {});
    const bridge = { writeFile } as unknown as DesktopBridge;
    const { result } = renderHook(() => useResearchExportTargets(), { wrapper: wrapper(bridge) });

    await result.current[0]!.run("# 报告正文", SESSION);

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, content] = writeFile.mock.calls[0] as unknown as [string, string];
    expect(path).toBe("/tmp/space/调研向量数据库选型.md");
    expect(content).toContain("来自 Cortex 深度研究");
    expect(content).toContain("# 报告正文");
  });

  it("写完切到写作工作区（点这个按钮的意图就是「拿它去写」）", async () => {
    setSpace("/tmp/space");
    usePersonalStore.setState({ writingOpen: false, researchOpen: true });
    const bridge = { writeFile: vi.fn(async () => {}) } as unknown as DesktopBridge;
    const { result } = renderHook(() => useResearchExportTargets(), { wrapper: wrapper(bridge) });

    await result.current[0]!.run("# 报告", SESSION);
    expect(usePersonalStore.getState().writingOpen).toBe(true);
    expect(usePersonalStore.getState().researchOpen).toBe(false);
  });

  it("写盘失败时把异常抛给调用方（由 ResearchRunView 统一展示原因）", async () => {
    setSpace("/tmp/space");
    const bridge = {
      writeFile: vi.fn(async () => {
        throw new Error("EACCES");
      }),
    } as unknown as DesktopBridge;
    const { result } = renderHook(() => useResearchExportTargets(), { wrapper: wrapper(bridge) });

    await expect(result.current[0]!.run("# 报告", SESSION)).rejects.toThrow("EACCES");
  });
});
