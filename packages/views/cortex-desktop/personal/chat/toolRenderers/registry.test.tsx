// 工具渲染注册表测试:注册/查表/回退语义,以及 ArtifactStepCard 的「查不到产物回退默认」约束。

import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePersonalStore } from "@cortex-work/core";
import { usePiArtifactsStore } from "@cortex-work/core/store/piArtifacts";

import { ArtifactStepCard } from "./ArtifactStepCard";
import { __clearToolRenderersForTest, getToolRenderer, registerToolRenderer } from "./registry";

describe("toolRenderers 注册表", () => {
  beforeEach(() => __clearToolRenderersForTest());

  it("注册/查表;未注册返回 undefined;同名后注册覆盖", () => {
    expect(getToolRenderer("bash")).toBeUndefined();
    const A: React.FC<{ item: unknown; fallback: React.ReactNode }> = () => <span>A</span>;
    const B: React.FC<{ item: unknown; fallback: React.ReactNode }> = () => <span>B</span>;
    registerToolRenderer("x", A as never);
    expect(getToolRenderer("x")).toBe(A);
    registerToolRenderer("x", B as never);
    expect(getToolRenderer("x")).toBe(B);
  });
});

describe("ArtifactStepCard", () => {
  beforeEach(() => {
    usePiArtifactsStore.setState({ sessions: {}, openReq: undefined });
    usePersonalStore.setState({ activeSessionId: "s1" });
  });

  it("产物存在:渲染可点击卡,点击 requestOpen(nonce 递增 + 定位产物)", () => {
    usePiArtifactsStore
      .getState()
      .applyEvent("s1", { type: "artifact", action: "create", filename: "chart.html", content: "<p/>" });
    render(
      <ArtifactStepCard
        item={{ ic: "check", text: "artifacts · 创建产物 chart.html", toolName: "artifacts", detail: "创建产物 chart.html" }}
        fallback={<span>默认</span>}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const { openReq } = usePiArtifactsStore.getState();
    expect(openReq).toMatchObject({ sessionId: "s1", filename: "chart.html", nonce: 1 });
  });

  it("store 查不到产物(已删)→ 回退默认渲染,不出死按钮", () => {
    render(
      <ArtifactStepCard
        item={{ ic: "check", text: "artifacts · 删除产物 gone.md", toolName: "artifacts", detail: "删除产物 gone.md" }}
        fallback={<span>默认文案</span>}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("默认文案")).toBeTruthy();
  });
});
