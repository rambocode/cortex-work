import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { TodosView, TODO_DRAG_MIME } from "./TodosView";

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

  it("首页只读模式:不渲染勾选按钮,改为状态点", () => {
    usePersonalStore.setState({ homeOpen: true });
    const { container } = renderTodos(fakeBridge({}));

    expect(container.querySelector(".pw-todo-check")).toBeNull();
    expect(container.querySelector(".pw-todo-dot")).not.toBeNull();
  });

  it("项目模式:勾选按钮可点击切换状态", () => {
    const { container } = renderTodos(fakeBridge({}));

    const check = container.querySelector<HTMLButtonElement>(".pw-todo-check");
    expect(check).not.toBeNull();
    fireEvent.click(check!);
    expect(usePersonalStore.getState().todos[0]?.status).toBe("done");
  });

  it("链接渲染:点击不导航,经 bridge.openExternal 开系统浏览器", async () => {
    const openExternal = vi.fn(async () => {});
    const bridge = {
      ...fakeBridge({ "/code/alpha/tasks/t1.md": "看 [文档](https://example.com/doc) 与 https://bare.example.com" }),
      openExternal,
    } as unknown as DesktopBridge;
    const { container } = renderTodos(bridge);

    fireEvent.click(screen.getByText("任务A"));
    const link = await screen.findByText("文档");
    expect(link.closest("a")?.getAttribute("href")).toBe("https://example.com/doc");
    // remark-gfm autolink:裸 URL 也渲染成链接。
    expect(container.querySelector('a[href="https://bare.example.com"]')).not.toBeNull();

    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/doc");
  });

  it("代码块:渲染 pre>code 并带语言角标 data-lang", async () => {
    const md = "```ts\nconst a = 1;\n```\n\n```\nplain\n```";
    const { container } = renderTodos(fakeBridge({ "/code/alpha/tasks/t1.md": md }));

    fireEvent.click(screen.getByText("任务A"));
    await waitFor(() => expect(container.querySelectorAll(".pw-todo-md pre")).toHaveLength(2));
    const pres = container.querySelectorAll(".pw-todo-md pre");
    expect(pres[0]!.getAttribute("data-lang")).toBe("ts");
    expect(pres[0]!.textContent).toContain("const a = 1;");
    // 未标语言的代码块不显示角标。
    expect(pres[1]!.hasAttribute("data-lang")).toBe(false);
  });

  it("callout:按类型渲染 class,标记文本不出现在正文", async () => {
    const md = "> [!important] 国际版不改服务器\n> 服务器地址与国内相同\n\n> [!warning]\n> 注意 APN\n\n> 普通引用";
    const { container } = renderTodos(fakeBridge({ "/code/alpha/tasks/t1.md": md }));

    fireEvent.click(screen.getByText("任务A"));
    await waitFor(() => expect(container.querySelectorAll(".pw-todo-md blockquote")).toHaveLength(3));

    const important = container.querySelector("blockquote.pw-md-callout.is-important");
    expect(important).not.toBeNull();
    expect(important?.getAttribute("data-callout")).toBe("important");
    expect(important?.textContent).toContain("国际版不改服务器");
    expect(important?.textContent).not.toContain("[!important]");

    expect(container.querySelector("blockquote.pw-md-callout.is-warning")?.textContent).toContain("注意 APN");
    // 普通引用不带 callout class。
    const quotes = [...container.querySelectorAll(".pw-todo-md blockquote")];
    expect(quotes.filter((q) => !q.classList.contains("pw-md-callout"))).toHaveLength(1);
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

// tasks/ 目录自动提取 + 单文件删除 + 压缩归档（listTaskFiles 能力齐全的桥）。
const JUNE12 = new Date(2026, 5, 12).getTime(); // 2026-W24

function richBridge(files: Record<string, string>) {
  const inTasks = (p: string, root: string) => p.startsWith(`${root}/tasks/`) && p.endsWith(".md");
  const entry = (p: string) => ({ name: p.slice(p.lastIndexOf("/") + 1), path: p, mtimeMs: JUNE12 });
  return {
    readFile: async (path: string) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return { content: files[path], truncated: false };
    },
    writeFile: async (path: string, content: string) => {
      files[path] = content;
    },
    deleteFile: async (path: string) => {
      delete files[path];
    },
    listTaskFiles: async (root: string) => ({
      files: Object.keys(files)
        .filter((p) => inTasks(p, root) && !p.includes("/archive/"))
        .map(entry),
      archived: Object.keys(files)
        .filter((p) => p.startsWith(`${root}/tasks/archive/`) && p.endsWith(".md"))
        .map(entry),
    }),
    // 压缩归档的总结模型走默认 agent 配置 → oneshotCli
    oneshotCli: async () => "# 2026-W24 任务归档\n\n本周完成…",
  } as unknown as DesktopBridge;
}

describe("Tasks 目录扫描与压缩归档", () => {
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

  it("自动列出 tasks/ 目录未登记的 md,已登记 todo 不重复显示", async () => {
    const { container } = renderTodos(
      richBridge({ "/code/alpha/tasks/t1.md": MD, "/code/alpha/tasks/2026-06-10-note.md": "# 随手记" }),
    );
    await screen.findByText("2026-06-10-note");
    // t1.md 已是 todo「任务A」,不应再出现为文件行
    expect(container.querySelectorAll(".pw-todo-row.is-file")).toHaveLength(1);
    expect(screen.getByText("任务A")).toBeInTheDocument();
  });

  it("文件行可打开详情、可单独删除", async () => {
    const files = { "/code/alpha/tasks/t1.md": MD, "/code/alpha/tasks/2026-06-10-note.md": "# 随手记\n内容" };
    renderTodos(richBridge(files));

    fireEvent.click(await screen.findByText("2026-06-10-note"));
    await screen.findByRole("heading", { name: "随手记" });
    fireEvent.click(screen.getByTitle("关闭详情"));

    fireEvent.click(await screen.findByTitle("删除文件"));
    await waitFor(() => expect(screen.queryByText("2026-06-10-note")).toBeNull());
    expect("/code/alpha/tasks/2026-06-10-note.md" in files).toBe(false);
  });

  it("压缩清理:按周归档未登记文件,跳过 open todo,写入 archive/ 并删除原文件", async () => {
    const files: Record<string, string> = {
      "/code/alpha/tasks/t1.md": MD, // open todo,应跳过保留
      "/code/alpha/tasks/2026-06-10-note.md": "# 随手记",
      "/code/alpha/tasks/2026-06-08-fix.md": "# 修复",
    };
    const toast = vi.fn();
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={richBridge(files)}>
        <TodosView onToast={toast} />
      </CoreProvider>,
    );

    fireEvent.click(await screen.findByTitle("压缩清理（按周/月/年归档 tasks 文件）"));
    fireEvent.click(screen.getByText("按周压缩"));
    fireEvent.click(await screen.findByText("2026-W24"));

    await waitFor(() => expect("/code/alpha/tasks/archive/2026-W24.md" in files).toBe(true));
    expect(files["/code/alpha/tasks/archive/2026-W24.md"]).toContain("本周完成");
    // 原文件删除,open todo 的文件保留
    expect("/code/alpha/tasks/2026-06-10-note.md" in files).toBe(false);
    expect("/code/alpha/tasks/2026-06-08-fix.md" in files).toBe(false);
    expect("/code/alpha/tasks/t1.md" in files).toBe(true);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("跳过 1 个未完成"));
  });

  it("清理菜单:点击外部自动关闭,点击菜单内不关闭", async () => {
    renderTodos(richBridge({ "/code/alpha/tasks/2026-06-10-note.md": "# 随手记" }));

    fireEvent.click(await screen.findByTitle("压缩清理（按周/月/年归档 tasks 文件）"));
    const item = screen.getByText("按周压缩");

    // 菜单内 mousedown 不关闭
    fireEvent.mouseDown(item);
    expect(screen.getByText("按周压缩")).toBeInTheDocument();

    // 菜单外 mousedown 自动关闭
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByText("按周压缩")).toBeNull());
  });

  it("清理菜单:鼠标移出区域自动收起,移入则取消收起", async () => {
    renderTodos(richBridge({ "/code/alpha/tasks/2026-06-10-note.md": "# 随手记" }));

    const btn = await screen.findByTitle("压缩清理（按周/月/年归档 tasks 文件）");
    const wrap = btn.closest(".pw-tb-menu-wrap") as HTMLElement;

    // 移出后短延迟自动收起
    fireEvent.click(btn);
    expect(screen.getByText("按周压缩")).toBeInTheDocument();
    fireEvent.mouseLeave(wrap);
    await waitFor(() => expect(screen.queryByText("按周压缩")).toBeNull());

    // 再次展开,移出后立即移入 → 取消收起,菜单保持
    fireEvent.click(btn);
    fireEvent.mouseLeave(wrap);
    fireEvent.mouseEnter(wrap);
    await new Promise((r) => setTimeout(r, 320));
    expect(screen.getByText("按周压缩")).toBeInTheDocument();
  });

  it("未登记文件行可拖拽:dragstart 写入 TODO_DRAG_MIME payload,detailPath 指向文件", async () => {
    const { container } = renderTodos(
      richBridge({ "/code/alpha/tasks/t1.md": MD, "/code/alpha/tasks/2026-06-10-note.md": "# 随手记" }),
    );
    await screen.findByText("2026-06-10-note");

    const row = container.querySelector(".pw-todo-row.is-file .pw-todo-row-main")!;
    expect(row.getAttribute("draggable")).toBe("true");

    const setData = vi.fn();
    fireEvent.dragStart(row, { dataTransfer: { setData, effectAllowed: "" } });
    expect(setData).toHaveBeenCalledWith(TODO_DRAG_MIME, expect.any(String));
    const payload = JSON.parse(setData.mock.calls[0]![1] as string);
    expect(payload).toMatchObject({
      id: "/code/alpha/tasks/2026-06-10-note.md",
      title: "2026-06-10-note",
      projectId: "p1",
      projectName: "alpha",
      detailPath: "/code/alpha/tasks/2026-06-10-note.md",
    });
  });

  it("归档文件出现在「归档」折叠分组,展开可见", async () => {
    renderTodos(
      richBridge({ "/code/alpha/tasks/t1.md": MD, "/code/alpha/tasks/archive/2026-W23.md": "# 上周归档" }),
    );
    const toggle = await screen.findByText("归档");
    expect(screen.queryByText("2026-W23")).toBeNull();
    fireEvent.click(toggle);
    await screen.findByText("2026-W23");
  });
});
