import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { CoreProvider, usePersonalStore, type DesktopBridge } from "@cortex-work/core";
import type { CanvasFilePort } from "@cortex-work/core/design/canvas/canvas-file-port";
import { useCanvasShapeStore } from "@cortex-work/core/design/canvas/canvas-shape-store";
import { createEmptyDocument } from "@cortex-work/core/design/canvas/canvas-types";
import { PersonalWhiteboardPanel } from "./PersonalWhiteboardPanel";

const captured = vi.hoisted(() => ({
  props: null as null | { workspaceRoot: string; filePort?: CanvasFilePort },
}));

vi.mock("../../design/canvas/CodeCanvasPanel", () => ({
  CodeCanvasPanel: (props: { workspaceRoot: string; filePort?: CanvasFilePort }) => {
    captured.props = props;
    return <div data-testid="code-canvas" data-workspace-root={props.workspaceRoot} />;
  },
}));

describe("PersonalWhiteboardPanel", () => {
  beforeEach(() => {
    captured.props = null;
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument());
  });

  afterEach(() => {
    cleanup();
  });

  it("首次直接打开白板时注入 Cortex 桌面文件端口", async () => {
    const writeFile = vi.fn(async () => undefined);
    const bridge = {
      readFile: vi.fn(async () => ({ content: "", truncated: false })),
      writeFile,
    } as unknown as DesktopBridge;
    usePersonalStore.setState({
      sessions: [{
        id: "session-1",
        title: "Session 1",
        agent: "pi",
        createdAt: 1,
        updatedAt: 1,
      }],
      activeSessionId: "session-1",
    });

    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <PersonalWhiteboardPanel
          sessionId="session-1"
          workspaceRoot="/workspace"
          onCollapse={() => {}}
        />
      </CoreProvider>,
    );

    await waitFor(() => expect(captured.props?.filePort).toBeDefined());
    await captured.props!.filePort!.writeText(
      "/workspace",
      ".cortex-canvas/code-session-1/canvas.json",
      "{}",
    );
    await captured.props!.filePort!.readText(
      "/workspace",
      ".cortex-canvas/code-session-1/canvas.json",
    );
    expect(writeFile).toHaveBeenCalledWith("/workspace/.cortex-canvas/code-session-1/canvas.json", "{}");
    expect(bridge.readFile).toHaveBeenCalledWith("/workspace/.cortex-canvas/code-session-1/canvas.json");
  });

  it("旧无项目会话缺少目录时补建并回写白板工作区", async () => {
    const ensureNoProjectDir = vi.fn(async () => "/documents/cortex/1970-01-01");
    const bridge = {
      ensureNoProjectDir,
      readFile: vi.fn(async () => ({ content: "", truncated: false })),
      writeFile: vi.fn(async () => undefined),
    } as unknown as DesktopBridge;
    usePersonalStore.setState({
      sessions: [{
        id: "legacy-session",
        title: "Legacy",
        agent: "pi",
        createdAt: 1,
        updatedAt: 1,
      }],
      activeSessionId: "legacy-session",
    });

    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <PersonalWhiteboardPanel
          sessionId="legacy-session"
          workspaceRoot=""
          onCollapse={() => {}}
        />
      </CoreProvider>,
    );

    await waitFor(() => {
      expect(captured.props?.workspaceRoot).toBe("/documents/cortex/1970-01-01");
    });
    expect(ensureNoProjectDir).toHaveBeenCalledWith("1970-01-01");
    expect(usePersonalStore.getState().sessions[0]?.noProjectDir).toBe("/documents/cortex/1970-01-01");
  });

  it("会话 Agent 正文中的 design_canvas 块会实时回放到白板", async () => {
    const bridge = {
      loadChat: vi.fn(async () => [
        { kind: "text", who: "me", time: "10:00", uid: "u1", text: "画一个模块" },
        {
          kind: "text",
          who: "claude",
          time: "10:01",
          uid: "a1",
          text: [
            "开始绘制。",
            "```design_canvas",
            JSON.stringify({
              action: "update_shapes",
              ops: [{ op: "add", shape: { type: "rect", name: "API", x: 20, y: 30 } }],
            }),
            "```",
          ].join("\n"),
        },
      ]),
      saveChat: vi.fn(async () => undefined),
      readFile: vi.fn(async () => ({ content: "", truncated: false })),
      writeFile: vi.fn(async () => undefined),
    } as unknown as DesktopBridge;
    usePersonalStore.setState({
      sessions: [{
        id: "session-ops",
        title: "Ops",
        agent: "claude",
        createdAt: 1,
        updatedAt: 1,
      }],
      activeSessionId: "session-ops",
      runningBySession: { "session-ops": "run-1" },
    });

    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <PersonalWhiteboardPanel
          sessionId="session-ops"
          workspaceRoot="/workspace"
          onCollapse={() => {}}
        />
      </CoreProvider>,
    );

    await waitFor(() => {
      const document = useCanvasShapeStore.getState().document;
      expect(Object.values(document.objects).some((shape) => shape.name === "API")).toBe(true);
    });
  });
});
