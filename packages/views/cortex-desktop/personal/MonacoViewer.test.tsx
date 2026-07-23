import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonacoViewer } from "./MonacoViewer";

const monacoMock = vi.hoisted(() => {
  const editorInstance = {
    getValue: vi.fn(() => ""),
    getModel: vi.fn(() => null),
    getSelection: vi.fn(() => null),
    onDidChangeModelContent: vi.fn(),
    onDidChangeCursorSelection: vi.fn(),
    onDidScrollChange: vi.fn(),
    addCommand: vi.fn(),
    updateOptions: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    create: vi.fn(() => editorInstance),
    defineTheme: vi.fn(),
  };
});

vi.mock("monaco-editor", () => ({
  editor: {
    create: monacoMock.create,
    defineTheme: monacoMock.defineTheme,
  },
  KeyMod: { CtrlCmd: 1 },
  KeyCode: { KeyS: 2 },
}));

class WorkerStub {
  constructor(
    readonly url: string | URL,
    readonly options?: WorkerOptions,
  ) {}
}

describe("MonacoViewer worker 路由", () => {
  beforeEach(() => {
    delete (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment;
    vi.stubGlobal("Worker", WorkerStub);
    monacoMock.create.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment;
  });

  it("html language service 使用 html.worker,不回退到 editor.worker 动态加载 foreign module", async () => {
    render(<MonacoViewer value="<main />" language="html" readOnly />);
    await waitFor(() => expect(monacoMock.create).toHaveBeenCalled());

    const environment = (globalThis as {
      MonacoEnvironment?: { getWorker?: (workerId: string, label: string) => WorkerStub };
    }).MonacoEnvironment;
    const worker = environment?.getWorker?.("workerMain.js", "html");

    expect(worker).toBeInstanceOf(WorkerStub);
    expect(String(worker?.url)).toContain("/vs/language/html/html.worker.js");
    expect(worker?.options).toMatchObject({ type: "module" });
  });
});
