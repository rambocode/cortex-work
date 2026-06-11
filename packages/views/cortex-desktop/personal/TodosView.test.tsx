import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { TodosView } from "./TodosView";

const NOW = Date.now();
const MD = "# 任务标题\n\n- [x] 已完成项\n- [ ] 待办项\n\n`inline-code`";

// 内存文件系统:readFile/writeFile 往返。
function fakeBridge(files: Record<string, string>): DesktopBridge {
  return {
    readFile: async (path: string) => ({ content: files[path] ?? "", truncated: false }),
    writeFile: async (path: string, content: string) => {
      files[path] = content;
    },
  } as unknown as DesktopBridge;
}

function renderTodos(bridge: DesktopBridge) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <TodosView onToast={() => {}} />
    </CoreProvider>,
  );
}

describe("TodosView 详情", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      activeProjectId: "p1",
      activeSessionId: undefined,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [],
      todos: [
        {
          id: "t1",
          projectId: "p1",
          title: "任务A",
          status: "open",
          detailPath: "/code/alpha/tasks/t1.md",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
  });

  it("预览渲染 GFM:标题/任务清单 checkbox/行内代码", async () => {
    const { container } = renderTodos(fakeBridge({ "/code/alpha/tasks/t1.md": MD }));

    fireEvent.click(screen.getByText("任务A"));
    expect(await screen.findByRole("heading", { name: "任务标题" })).toBeInTheDocument();
    const boxes = container.querySelectorAll('.pw-todo-md li.task-list-item > input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect(container.querySelector(".pw-todo-md code")?.textContent).toBe("inline-code");
  });

  it("就地编辑:无浮层,textarea 原位替换预览,保存后写盘并回到预览", async () => {
    const files = { "/code/alpha/tasks/t1.md": MD };
    const { container } = renderTodos(fakeBridge(files));

    fireEvent.click(screen.getByText("任务A"));
    await screen.findByRole("heading", { name: "任务标题" });

    fireEvent.click(screen.getByTitle("编辑详情"));
    // 无 modal 浮层,编辑区就地出现。
    expect(container.querySelector(".pw-todo-modal")).toBeNull();
    const ta = container.querySelector<HTMLTextAreaElement>(".pw-todo-edit-ta");
    expect(ta?.value).toBe(MD);

    fireEvent.change(ta!, { target: { value: "# 新标题\n\n正文" } });
    fireEvent.click(screen.getByText("保存"));

    await screen.findByRole("heading", { name: "新标题" });
    expect(files["/code/alpha/tasks/t1.md"]).toBe("# 新标题\n\n正文");
    expect(container.querySelector(".pw-todo-edit-ta")).toBeNull();
  });

  it("编辑区带行号槽:行数与内容一致,输入后随之增长", async () => {
    const { container } = renderTodos(fakeBridge({ "/code/alpha/tasks/t1.md": MD }));

    fireEvent.click(screen.getByText("任务A"));
    await screen.findByRole("heading", { name: "任务标题" });
    fireEvent.click(screen.getByTitle("编辑详情"));

    const lines = MD.split("\n").length;
    expect(container.querySelectorAll(".pw-todo-edit-gutter span")).toHaveLength(lines);

    const ta = container.querySelector<HTMLTextAreaElement>(".pw-todo-edit-ta")!;
    fireEvent.change(ta, { target: { value: MD + "\n新行" } });
    expect(container.querySelectorAll(".pw-todo-edit-gutter span")).toHaveLength(lines + 1);
    expect(container.querySelector(".pw-todo-edit-gutter span:last-child")?.textContent).toBe(String(lines + 1));
  });

  it("Esc 取消编辑,不写盘", async () => {
    const files = { "/code/alpha/tasks/t1.md": MD };
    const { container } = renderTodos(fakeBridge(files));

    fireEvent.click(screen.getByText("任务A"));
    await screen.findByRole("heading", { name: "任务标题" });
    fireEvent.click(screen.getByTitle("编辑详情"));

    const ta = container.querySelector<HTMLTextAreaElement>(".pw-todo-edit-ta")!;
    fireEvent.change(ta, { target: { value: "改了但不保存" } });
    fireEvent.keyDown(ta, { key: "Escape" });

    await waitFor(() => expect(container.querySelector(".pw-todo-edit-ta")).toBeNull());
    expect(files["/code/alpha/tasks/t1.md"]).toBe(MD);
    expect(screen.getByRole("heading", { name: "任务标题" })).toBeInTheDocument();
  });
});
