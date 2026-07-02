import { act, cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { TaskInput, TaskMeta, TaskProject } from "@cortex-work/core/desktop/types";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { useTasksChangeSubscription } from "@cortex-work/core/personal/tasks";
import { TaskListColumn } from "./TaskListColumn";
import type { WorkbenchSelection } from "./ProjectsWorkbench";
import type { TaskViewFilter } from "@cortex-work/core/personal/tasks";

// U10：未选中行标题为纯文本 span（用 getByText 定位），选中行标题为可编辑 input（用 getByDisplayValue）。
// 下面多数用例只需「按标题定位行」，helper 两态兼容：优先取纯文本节点，退回取输入值节点。
function titleNode(name: string): HTMLElement {
  const t = screen.queryByText(name);
  if (t) return t as HTMLElement;
  return screen.getByDisplayValue(name) as HTMLElement;
}
function rowOf(name: string): HTMLElement {
  return titleNode(name).closest(".pw-task-row") as HTMLElement;
}
async function findTitle(name: string): Promise<HTMLElement> {
  return (await screen.findByText(name)) as HTMLElement;
}

// 内存任务桥：tasksList/add/update/delete/listProjects/onTasksChanged，并记录新增入参（快速新增归属断言用）。
function fakeTasksBridge(initial: TaskMeta[] = [], initialProjects: TaskProject[] = []) {
  const store = new Map<string, TaskMeta>(initial.map((t) => [t.id, t]));
  let idc = 0;
  const calls = {
    added: [] as TaskInput[],
    update: [] as Array<{ id: string; patch: Record<string, unknown> }>,
    deleted: [] as string[],
  };
  const bridge = {
    tasksList: async (pid?: string) => {
      const all = [...store.values()];
      return pid === undefined ? all : all.filter((t) => t.projectId === pid);
    },
    tasksListProjects: async () => initialProjects,
    tasksAdd: async (input: TaskInput) => {
      calls.added.push(input);
      const id = `t${++idc}`;
      const now = Date.now();
      const m: TaskMeta = {
        id,
        title: input.title,
        status: "active",
        tags: [],
        projectId: input.projectId,
        source: input.source ?? "manual",
        createdAt: now,
        updatedAt: now,
      };
      store.set(id, m);
      return m;
    },
    tasksUpdate: async (id: string, patch: Record<string, unknown>) => {
      calls.update.push({ id, patch });
      const cur = store.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updatedAt: Date.now() } as TaskMeta;
      store.set(id, next);
      return next;
    },
    tasksDelete: async (id: string) => {
      calls.deleted.push(id);
      store.delete(id);
    },
    onTasksChanged: () => () => {},
  } as unknown as DesktopBridge;
  return { bridge, store, calls };
}

// 四档过滤缺省 remaining（对齐旧「进行中」直觉）；opts 可覆盖 filter 与选中回调用于断言。
function renderColumn(
  bridge: DesktopBridge,
  selection: WorkbenchSelection,
  selectedTaskId?: string | null,
  opts: {
    filter?: TaskViewFilter;
    forcedVisibleId?: string | null;
    onCreated?: (id: string) => void;
    onSelectedHidden?: () => void;
    onOpenTask?: (id: string) => void;
  } = {},
) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <TaskListColumn
        selection={selection}
        selectedTaskId={selectedTaskId}
        filter={opts.filter ?? "remaining"}
        forcedVisibleId={opts.forcedVisibleId}
        onOpenTask={opts.onOpenTask ?? (() => {})}
        onCreated={opts.onCreated ?? (() => {})}
        onSelectedHidden={opts.onSelectedHidden ?? (() => {})}
        onToast={() => {}}
      />
    </CoreProvider>,
  );
}

// 造一条活动任务的便捷工厂。
function task(id: string, title: string, extra: Partial<TaskMeta> = {}): TaskMeta {
  return { id, title, status: "active", tags: [], source: "manual", createdAt: 0, updatedAt: 0, ...extra };
}

// 「活」任务桥：捕获 onTasksChanged 监听器 + 记录 tasksList 调用次数，用于模拟另一列/另一窗口
// 落库后经 main 广播的 tasks:changed（emitExternal 改 store 后触发监听 → React Query invalidate 重拉）。
function liveTasksBridge(initial: TaskMeta[] = [], initialProjects: TaskProject[] = []) {
  const store = new Map<string, TaskMeta>(initial.map((t) => [t.id, t]));
  let listener: (() => void) | null = null;
  let listCalls = 0;
  const bridge = {
    tasksList: async (pid?: string) => {
      listCalls++;
      const all = [...store.values()];
      return pid === undefined ? all : all.filter((t) => t.projectId === pid);
    },
    tasksListProjects: async () => initialProjects,
    tasksUpdate: async (id: string, patch: Record<string, unknown>) => {
      const cur = store.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updatedAt: Date.now() } as TaskMeta;
      store.set(id, next);
      return next;
    },
    onTasksChanged: (cb: () => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  } as unknown as DesktopBridge;
  // 模拟外部（另一列/窗口/后台委派回写）改动 + main 广播。
  const emitExternal = (id: string, patch: Partial<TaskMeta>) => {
    const cur = store.get(id);
    if (cur) store.set(id, { ...cur, ...patch, updatedAt: Date.now() });
    listener?.();
  };
  return { bridge, store, emitExternal, listCount: () => listCalls };
}

// 工作台根挂 useTasksChangeSubscription（订阅 tasks:changed → invalidate）；中列本身不挂，
// 故测试里补一个订阅探针，复刻真实窗口根的挂载点。
function Sub() {
  useTasksChangeSubscription();
  return null;
}

function renderLiveColumn(bridge: DesktopBridge, selection: WorkbenchSelection, selectedTaskId?: string | null) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <Sub />
      <TaskListColumn
        selection={selection}
        selectedTaskId={selectedTaskId}
        filter="remaining"
        onOpenTask={() => {}}
        onCreated={() => {}}
        onSelectedHidden={() => {}}
        onToast={() => {}}
      />
    </CoreProvider>,
  );
}

// 只 fake Date（冻结「今天」为 2026-07-01），保留真实 setTimeout 让 RTL findBy/waitFor 正常工作。
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-01T12:00:00"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // 折叠态是模块级 Zustand 单例，重置防跨用例串扰。
  usePersonalStore.setState({ collapsedTasks: {} });
});

describe("TaskListColumn", () => {
  it("选中 project 聚合其子树（自身 + 子项目）任务，排除无关项目", async () => {
    const projects: TaskProject[] = [
      { id: "p1", name: "项目一" },
      { id: "p1a", name: "子项目", parentId: "p1" },
      { id: "p2", name: "无关" },
    ];
    const { bridge } = fakeTasksBridge(
      [
        task("a", "属于p1", { projectId: "p1" }),
        task("b", "属于子项目", { projectId: "p1a" }),
        task("c", "无关任务", { projectId: "p2" }),
      ],
      projects,
    );
    renderColumn(bridge, { kind: "project", id: "p1" });

    // 未选中行标题为纯文本（U10）→ 用 getByText 断言。
    expect(await findTitle("属于p1")).toBeTruthy();
    expect(screen.getByText("属于子项目")).toBeTruthy();
    expect(screen.queryByText("无关任务")).toBeNull();
  });

  it("选中 folder 聚合其后代 project 任务，排除文件夹外任务", async () => {
    const projects: TaskProject[] = [
      { id: "f1", name: "分组", kind: "folder" },
      { id: "p1", name: "项目", parentId: "f1" },
      { id: "p2", name: "外部", kind: "project" },
    ];
    const { bridge } = fakeTasksBridge(
      [task("a", "组内任务", { projectId: "p1" }), task("b", "组外任务", { projectId: "p2" })],
      projects,
    );
    renderColumn(bridge, { kind: "folder", id: "f1" });

    expect(await findTitle("组内任务")).toBeTruthy();
    expect(screen.queryByText("组外任务")).toBeNull();
  });

  it("组内排序：flag → 逾期 → 有 due（升序）→ 无 due 末尾", async () => {
    // 单 project 子树 → 单组无头，直接校验行的 DOM 顺序即组内排序。
    const { bridge } = fakeTasksBridge(
      [
        task("s1", "无due", { projectId: "p1" }),
        task("s2", "未逾期", { projectId: "p1", dueDate: "2026-07-10" }),
        task("s3", "逾期", { projectId: "p1", dueDate: "2026-06-20" }),
        task("s4", "已标记", { projectId: "p1", flagged: true }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    const { container } = renderColumn(bridge, { kind: "project", id: "p1" });

    await findTitle("无due");
    // 未选中行标题为纯文本 span（U10）→ 按 DOM 顺序读各标题 textContent 即组内排序。
    const order = Array.from(container.querySelectorAll<HTMLElement>(".pw-task-title-static")).map(
      (el) => el.textContent,
    );
    expect(order).toEqual(["已标记", "逾期", "未逾期", "无due"]);
  });

  it("四档过滤（U5）：remaining 隐藏 done；all 显 done/dropped", async () => {
    const tasks = [
      task("a", "活动任务", { projectId: "p1" }),
      task("b", "完成任务", { projectId: "p1", status: "done" }),
    ];
    // remaining：只见活动任务（done 隐藏）。
    const { bridge } = fakeTasksBridge(tasks, [{ id: "p1", name: "项目一" }]);
    renderColumn(bridge, { kind: "project", id: "p1" }, undefined, { filter: "remaining" });
    expect(await findTitle("活动任务")).toBeTruthy();
    expect(screen.queryByText("完成任务")).toBeNull();
    cleanup();
    // all：done/dropped 可被找回。
    const { bridge: b2 } = fakeTasksBridge(tasks, [{ id: "p1", name: "项目一" }]);
    renderColumn(b2, { kind: "project", id: "p1" }, undefined, { filter: "all" });
    expect(await findTitle("完成任务")).toBeTruthy();
    expect(screen.getByText("活动任务")).toBeTruthy();
  });

  it("选中行行内直接编辑标题 → blur 保存（U10：仅选中行可编辑）", async () => {
    const { bridge, calls } = fakeTasksBridge([task("a", "原名", { projectId: "p1" })], [{ id: "p1", name: "项目一" }]);
    // 选中该行 → 标题渲染为可编辑 input。
    renderColumn(bridge, { kind: "project", id: "p1" }, "a");

    const input = await screen.findByDisplayValue("原名");
    fireEvent.change(input, { target: { value: "新名" } });
    fireEvent.blur(input);
    await waitFor(() => expect(calls.update.some((u) => u.id === "a" && u.patch.title === "新名")).toBe(true));
  });

  it("点击未选中行标题触发选中（onOpenTask），而非进入编辑（U10）", async () => {
    const onOpenTask = vi.fn();
    const { bridge } = fakeTasksBridge([task("a", "只读标题", { projectId: "p1" })], [{ id: "p1", name: "项目一" }]);
    renderColumn(bridge, { kind: "project", id: "p1" }, null, { onOpenTask });

    const title = await findTitle("只读标题");
    // 纯文本 span（非可编辑 input）。
    expect(title.tagName).toBe("SPAN");
    // 点击标题经行级 onClick 选中该行，而非进入编辑。
    fireEvent.click(title);
    expect(onOpenTask).toHaveBeenCalledWith("a");
  });

  it("folder 快速新增落 Inbox（projectId 为空）", async () => {
    const projects: TaskProject[] = [
      { id: "f1", name: "分组", kind: "folder" },
      { id: "p1", name: "项目", parentId: "f1" },
    ];
    const { bridge, calls } = fakeTasksBridge([], projects);
    renderColumn(bridge, { kind: "folder", id: "f1" });

    const input = screen.getByPlaceholderText(/添加任务/);
    fireEvent.change(input, { target: { value: "买菜" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(calls.added.length).toBe(1));
    const added = calls.added[0]!;
    expect(added.title).toBe("买菜");
    expect(added.projectId).toBeUndefined();
  });
});

describe("TaskListColumn 子任务嵌套（U3）", () => {
  it("项目视图下子任务缩进渲染在父下", async () => {
    const { bridge } = fakeTasksBridge(
      [
        task("parent", "父任务", { projectId: "p1" }),
        task("child", "子任务", { projectId: "p1", parentTaskId: "parent" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    renderColumn(bridge, { kind: "project", id: "p1" });

    await findTitle("父任务");
    const parentRow = rowOf("父任务");
    const childRow = rowOf("子任务");
    // 父行无缩进、子行有缩进占位。
    expect(parentRow.querySelector(".pw-task-indent")).toBeNull();
    expect(childRow.querySelector(".pw-task-indent")).not.toBeNull();
    // 父行有折叠箭头（有子任务）。
    expect(parentRow.querySelector(".pw-task-twisty:not(.pw-task-twisty-spacer)")).not.toBeNull();
  });

  it("折叠父任务 → 子任务隐藏，再展开 → 恢复", async () => {
    const { bridge } = fakeTasksBridge(
      [
        task("parent", "父任务", { projectId: "p1" }),
        task("child", "子任务", { projectId: "p1", parentTaskId: "parent" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    renderColumn(bridge, { kind: "project", id: "p1" });

    await findTitle("子任务");
    const twisty = rowOf("父任务").querySelector<HTMLButtonElement>(".pw-task-twisty")!;
    fireEvent.click(twisty);
    expect(screen.queryByText("子任务")).toBeNull();
    fireEvent.click(twisty);
    expect(screen.getByText("子任务")).toBeTruthy();
  });

  it("添加子任务透传 parentId 并继承父项目", async () => {
    const { bridge, calls } = fakeTasksBridge(
      [task("parent", "父任务", { projectId: "p1" })],
      [{ id: "p1", name: "项目一" }],
    );
    renderColumn(bridge, { kind: "project", id: "p1" });

    await findTitle("父任务");
    const parentRow = rowOf("父任务");
    fireEvent.click(within(parentRow).getByTitle("添加子任务"));

    await waitFor(() => expect(calls.added.length).toBe(1));
    expect(calls.added[0]!.parentId).toBe("parent");
    expect(calls.added[0]!.projectId).toBe("p1");
  });

  it("删除含子任务的父 → 首击确认 toast、再击才删", async () => {
    const toasts: string[] = [];
    const { bridge, calls } = fakeTasksBridge(
      [
        task("parent", "父任务", { projectId: "p1" }),
        task("child", "子任务", { projectId: "p1", parentTaskId: "parent" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <TaskListColumn selection={{ kind: "project", id: "p1" }} filter="remaining" onOpenTask={() => {}} onCreated={() => {}} onSelectedHidden={() => {}} onToast={(t) => toasts.push(t)} />
      </CoreProvider>,
    );

    await findTitle("父任务");
    const parentRow = rowOf("父任务");
    const del = within(parentRow).getByTitle("删除");
    fireEvent.click(del); // 首击：仅确认
    expect(calls.deleted.length).toBe(0);
    expect(toasts.some((t) => t.includes("子任务"))).toBe(true);
    fireEvent.click(del); // 再击：真删
    await waitFor(() => expect(calls.deleted).toContain("parent"));
  });

  it("删除无子任务的叶子任务 → 立即删除、不弹确认", async () => {
    const toasts: string[] = [];
    const { bridge, calls } = fakeTasksBridge([task("a", "叶子", { projectId: "p1" })], [{ id: "p1", name: "项目一" }]);
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <TaskListColumn selection={{ kind: "project", id: "p1" }} filter="remaining" onOpenTask={() => {}} onCreated={() => {}} onSelectedHidden={() => {}} onToast={(t) => toasts.push(t)} />
      </CoreProvider>,
    );
    await findTitle("叶子");
    const row = rowOf("叶子");
    fireEvent.click(within(row).getByTitle("删除"));
    await waitFor(() => expect(calls.deleted).toContain("a"));
    expect(toasts.some((t) => t.includes("子任务"))).toBe(false); // 无确认 toast
  });

  it("waiting 父（已委派）全部子完成 → 点「完成此任务」被 canTransition 拒绝、不置 done、toast", async () => {
    const toasts: string[] = [];
    const { bridge, calls } = fakeTasksBridge(
      [
        task("p", "已委派父", {
          projectId: "p1",
          status: "waiting",
          delegation: { sessionId: "s1", state: "running" },
        }),
        task("c", "子", { projectId: "p1", parentTaskId: "p", status: "done" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <TaskListColumn selection={{ kind: "project", id: "p1" }} filter="remaining" onOpenTask={() => {}} onCreated={() => {}} onSelectedHidden={() => {}} onToast={(t) => toasts.push(t)} />
      </CoreProvider>,
    );
    const suggest = await screen.findByText("✓ 完成此任务");
    fireEvent.click(suggest);
    // waiting→done 非用户合法迁移 → 不发 done patch、给 toast。
    expect(calls.update.some((u) => u.patch.status === "done")).toBe(false);
    expect(toasts.some((t) => t.includes("无法"))).toBe(true);
  });

  it("折叠父后点「添加子任务」→ 父自动展开、子可见", async () => {
    const { bridge } = fakeTasksBridge(
      [
        task("p", "父", { projectId: "p1" }),
        task("c", "既有子", { projectId: "p1", parentTaskId: "p" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    renderColumn(bridge, { kind: "project", id: "p1" });
    await findTitle("既有子");
    const parentRow = () => rowOf("父");
    // 先折叠父 → 既有子隐藏。
    fireEvent.click(parentRow().querySelector<HTMLButtonElement>(".pw-task-twisty")!);
    expect(screen.queryByText("既有子")).toBeNull();
    // 点「添加子任务」→ 父自动展开，既有子重新可见。
    fireEvent.click(within(parentRow()).getByTitle("添加子任务"));
    await waitFor(() => expect(screen.queryByText("既有子")).not.toBeNull());
  });

  it("全部子任务完成 → 父浮现「完成此任务」建议，点击才置 done", async () => {
    const { bridge, calls } = fakeTasksBridge(
      [
        task("parent", "父任务", { projectId: "p1" }),
        task("child", "子任务", { projectId: "p1", parentTaskId: "parent", status: "done" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    renderColumn(bridge, { kind: "project", id: "p1" });

    // 父行浮现建议（子任务 done 被中列活动过滤，但 rollup 派生看全量）。
    const suggest = await screen.findByText("✓ 完成此任务");
    expect(calls.update.length).toBe(0); // 未自动 done
    fireEvent.click(suggest);
    await waitFor(() => expect(calls.update.some((u) => u.id === "parent" && u.patch.status === "done")).toBe(true));
  });

  it("选中任务 → 行高亮 + 行内展开 inspector（含状态控件）", async () => {
    const { bridge } = fakeTasksBridge([task("a", "被选中", { projectId: "p1" })], [{ id: "p1", name: "项目一" }]);
    renderColumn(bridge, { kind: "project", id: "p1" }, "a");

    // 选中行标题为可编辑 input（U10）。
    await screen.findByDisplayValue("被选中");
    const row = screen.getByDisplayValue("被选中").closest(".pw-task-row")!;
    expect(row.classList.contains("is-selected")).toBe(true);
    // 行内 inspector 挂载（共享字段面板的状态控件出现）。
    expect(row.querySelector(".pw-task-inspector .pw-task-inspect-bar")).not.toBeNull();
  });

  it("未选中任务不渲染行内 inspector，标题为纯文本（U10）", async () => {
    const { bridge } = fakeTasksBridge([task("a", "未选", { projectId: "p1" })], [{ id: "p1", name: "项目一" }]);
    renderColumn(bridge, { kind: "project", id: "p1" }, null);

    const title = await findTitle("未选");
    expect(title.tagName).toBe("SPAN");
    const row = rowOf("未选");
    expect(row.classList.contains("is-selected")).toBe(false);
    expect(row.querySelector(".pw-task-inspector")).toBeNull();
  });

  // ── U1 跨列编辑同步：中列标题/备注草稿守卫回归（U10：标题草稿仅选中行 input 生效）──────────
  it("选中行外部改标题（模拟另一列 blur 落库 + tasks:changed）→ 标题 input 跟随更新", async () => {
    const { bridge, emitExternal } = liveTasksBridge(
      [task("a", "原名", { projectId: "p1" })],
      [{ id: "p1", name: "项目一" }],
    );
    // U10：标题草稿守卫只作用于选中行的可编辑 input，故此回归以选中态渲染。
    renderLiveColumn(bridge, { kind: "project", id: "p1" }, "a");

    expect(await screen.findByDisplayValue("原名")).toBeTruthy();
    // 另一列（右栏/另一窗口）改了标题并落库 → main 广播 tasks:changed。
    act(() => emitExternal("a", { title: "改后" }));
    // 修复前：中列 input 因草稿仅按 task.id 冻结而停留「原名」；修复后跟随外部值。
    expect(await screen.findByDisplayValue("改后")).toBeTruthy();
    expect(screen.queryByDisplayValue("原名")).toBeNull();
  });

  it("选中行标题聚焦输入中 → 外部 tasks:changed 到达，草稿不被覆盖（AE2）", async () => {
    const { bridge, emitExternal, listCount } = liveTasksBridge(
      [task("a", "原名", { projectId: "p1" })],
      [{ id: "p1", name: "项目一" }],
    );
    renderLiveColumn(bridge, { kind: "project", id: "p1" }, "a");

    const input = (await screen.findByDisplayValue("原名")) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "编辑中未保存" } });
    const before = listCount();
    act(() => emitExternal("a", { title: "外部改" }));
    // 等 refetch 真正落地（tasksList 再次被调用），确保断言发生在外部更新已到达之后。
    await waitFor(() => expect(listCount()).toBeGreaterThan(before));
    // 聚焦中 → 草稿保护：仍是用户正在输入的文本，未被外部「外部改」覆盖。
    expect(input.value).toBe("编辑中未保存");
  });

  it("外部改备注 → 选中行内联检查器 note 文本跟随（TaskInlineInspector noteDraft）", async () => {
    const { bridge, emitExternal } = liveTasksBridge(
      [task("a", "任务", { projectId: "p1" })],
      [{ id: "p1", name: "项目一" }],
    );
    renderLiveColumn(bridge, { kind: "project", id: "p1" }, "a");

    await screen.findByDisplayValue("任务");
    // 展开就地备注编辑器。
    fireEvent.click(screen.getByText("添加备注"));
    const ta = (await screen.findByPlaceholderText("备注…")) as HTMLTextAreaElement;
    fireEvent.blur(ta); // 确保未聚焦（autoFocus 会置聚焦态，聚焦中会正当地忽略外部更新）
    act(() => emitExternal("a", { notes: "右栏写的备注" }));
    await waitFor(() => expect(ta.value).toBe("右栏写的备注"));
  });

  it("Today 视图下父不在 scope → 子任务扁平（无缩进）", async () => {
    const { bridge } = fakeTasksBridge(
      [
        // 父无 due → 不进 Today；子 due=今天 → 进 Today，父不在 scope 故子升顶层。
        task("parent", "父任务", { projectId: "p1" }),
        task("child", "子任务", { projectId: "p1", parentTaskId: "parent", dueDate: "2026-07-01" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    renderColumn(bridge, { kind: "today" });

    await findTitle("子任务");
    expect(screen.queryByText("父任务")).toBeNull();
    const childRow = rowOf("子任务");
    expect(childRow.querySelector(".pw-task-indent")).toBeNull(); // depth 0，无缩进
  });
});

// ── U5 四档过滤 / 上下文补行 / 强制可见 / R18 ─────────────────────────────────
describe("TaskListColumn 四档过滤（U5）", () => {
  it("父被 defer 滤掉、子可用：子显示 + 灰显父上下文行（不可编辑标题）", async () => {
    const { bridge } = fakeTasksBridge(
      [
        // 父 defer 到未来（available 档下被滤）；子无 defer（available 命中）。
        task("parent", "父任务", { projectId: "p1", deferDate: "2026-07-05" }),
        task("child", "子任务", { projectId: "p1", parentTaskId: "parent" }),
      ],
      [{ id: "p1", name: "项目一", mode: "parallel" }],
    );
    const { container } = renderColumn(bridge, { kind: "project", id: "p1" }, undefined, { filter: "available" });

    // 命中子的行标题为纯文本 span（U10 未选中只读态）。
    expect(await findTitle("子任务")).toBeTruthy();
    // 父作上下文补行：灰显、无 input，且不计入命中（无 checkbox input）。
    const ctx = container.querySelector(".pw-task-row.is-context")!;
    expect(ctx).not.toBeNull();
    expect(ctx.textContent).toContain("父任务");
    expect(ctx.querySelector("input")).toBeNull(); // 补行不可勾选/不可编辑
    // 父只作上下文补行出现，不作为命中行渲染（其「父任务」文本落在 is-context 行内）。
    expect(screen.getByText("父任务").closest(".pw-task-row")!.classList.contains("is-context")).toBe(true);
  });

  it("R18：选中任务完成后离开命中集 → 触发 onSelectedHidden", async () => {
    const onSelectedHidden = vi.fn();
    const { bridge } = fakeTasksBridge([task("a", "被选中", { projectId: "p1" })], [{ id: "p1", name: "项目一" }]);
    renderColumn(bridge, { kind: "project", id: "p1" }, "a", { filter: "remaining", onSelectedHidden });

    // 选中行标题为可编辑 input（U10）。
    const row = (await screen.findByDisplayValue("被选中")).closest(".pw-task-row")!;
    // 勾选完成 → status done → remaining 档不再命中 → 通知容器清选中。
    fireEvent.click(row.querySelector<HTMLInputElement>(".pw-task-check")!);
    await waitFor(() => expect(onSelectedHidden).toHaveBeenCalled());
  });

  it("R11：forcedVisibleId 使新建任务无视「首先可用」过滤仍可见", async () => {
    const tasks = [
      task("a1", "首个可用", { projectId: "p1" }),
      task("x", "新建任务", { projectId: "p1" }),
    ];
    // 无 forced：first-available 每项目至多一条 → 仅「首个可用」。
    const { bridge } = fakeTasksBridge(tasks, [{ id: "p1", name: "项目一", mode: "parallel" }]);
    renderColumn(bridge, { kind: "project", id: "p1" }, undefined, { filter: "first-available" });
    expect(await findTitle("首个可用")).toBeTruthy();
    expect(screen.queryByText("新建任务")).toBeNull();
    cleanup();
    // forcedVisibleId=x：新建任务被强制并入命中，两条都可见。选中 x → 其标题为 input。
    const { bridge: b2 } = fakeTasksBridge(tasks, [{ id: "p1", name: "项目一", mode: "parallel" }]);
    renderColumn(b2, { kind: "project", id: "p1" }, "x", { filter: "first-available", forcedVisibleId: "x" });
    expect(await screen.findByDisplayValue("新建任务")).toBeTruthy();
    expect(screen.getByText("首个可用")).toBeTruthy();
  });

  it("P2：父被过滤成上下文补行且此前被折叠 → 命中子行仍渲染（补行无展开三角，不能藏死子）", async () => {
    const { bridge } = fakeTasksBridge(
      [
        // 父 defer 到未来（available 档被滤 → 仅作上下文补行）；子无 defer（available 命中）。
        task("parent", "父任务", { projectId: "p1", deferDate: "2026-07-05" }),
        task("child", "子任务", { projectId: "p1", parentTaskId: "parent" }),
      ],
      [{ id: "p1", name: "项目一", mode: "parallel" }],
    );
    // 预置父为折叠态：修复前折叠会连带把命中子行藏死（补行无三角，永久不可达）。
    usePersonalStore.setState({ collapsedTasks: { parent: true } });
    const { container } = renderColumn(bridge, { kind: "project", id: "p1" }, undefined, { filter: "available" });

    // 命中子行仍应渲染。
    expect(await findTitle("子任务")).toBeTruthy();
    // 父仍作上下文补行呈现（灰显、不可编辑）。
    expect(container.querySelector(".pw-task-row.is-context")?.textContent).toContain("父任务");
  });

  it("P3：today 视图 scope 非空但全被过滤 → 空态文案为「无匹配动作」（不误显「暂无任务」）", async () => {
    const { bridge } = fakeTasksBridge(
      [
        // due=今天 → 进 Today scope；同时 defer 到未来 → available 档不可用 → 全滤空。
        task("a", "今天到期但被推迟", { projectId: "p1", dueDate: "2026-07-01", deferDate: "2026-07-05" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    const { container } = renderColumn(bridge, { kind: "today" }, undefined, { filter: "available" });
    // scope 有 1 条（today-eligible），但 available 档全滤空 → 应走「无匹配动作」分支，而非今日「暂无任务」。
    await waitFor(() => expect(container.querySelector(".pw-empty-hint")?.textContent).toContain("无匹配动作"));
  });

  it("R26 空态双文案：scope 有任务但全被过滤 → 「无匹配动作」；scope 空 → 「暂无任务」", async () => {
    // scope 有一条 done 任务，但 remaining 档全滤掉 → 无匹配动作。
    const { bridge } = fakeTasksBridge(
      [task("d", "已完成", { projectId: "p1", status: "done" })],
      [{ id: "p1", name: "项目一" }],
    );
    const { container } = renderColumn(bridge, { kind: "project", id: "p1" }, undefined, { filter: "remaining" });
    await waitFor(() => expect(container.querySelector(".pw-empty-hint")?.textContent).toContain("无匹配动作"));
    cleanup();
    // scope 本就空 → 项目暂无任务文案。
    const { bridge: b2 } = fakeTasksBridge([], [{ id: "p1", name: "项目一" }]);
    const { container: c2 } = renderColumn(b2, { kind: "project", id: "p1" }, undefined, { filter: "remaining" });
    await waitFor(() => expect(c2.querySelector(".pw-empty-hint")?.textContent).toContain("暂无任务"));
  });
});

// ── U6 大纲式：统计条 / 划线 / 占位 chips / 组头折叠 / 今日跨项目分组 ─────────────
describe("TaskListColumn 大纲式（U6）", () => {
  it("统计条：remaining 与 all 档动作数不同、项目数取范围 project 数", async () => {
    const tasks = [
      task("a", "活动一", { projectId: "p1" }),
      task("b", "活动二", { projectId: "p1" }),
      task("c", "完成", { projectId: "p1", status: "done" }),
    ];
    const { bridge } = fakeTasksBridge(tasks, [{ id: "p1", name: "项目一" }]);
    const { container } = renderColumn(bridge, { kind: "project", id: "p1" }, undefined, { filter: "remaining" });
    await findTitle("活动一");
    expect(container.querySelector(".pw-outline-count")?.textContent).toBe("2 个动作，1 个项目");
    cleanup();
    const { bridge: b2 } = fakeTasksBridge(tasks, [{ id: "p1", name: "项目一" }]);
    const { container: c2 } = renderColumn(b2, { kind: "project", id: "p1" }, undefined, { filter: "all" });
    await findTitle("完成");
    expect(c2.querySelector(".pw-outline-count")?.textContent).toBe("3 个动作，1 个项目");
  });

  it("「已选择」条随选中出现，点击清除调用 onSelectedHidden", async () => {
    const onSelectedHidden = vi.fn();
    const { bridge } = fakeTasksBridge([task("a", "被选中", { projectId: "p1" })], [{ id: "p1", name: "项目一" }]);
    const { container } = renderColumn(bridge, { kind: "project", id: "p1" }, "a", { onSelectedHidden });
    await screen.findByDisplayValue("被选中");
    const bar = container.querySelector(".pw-outline-selected")!;
    expect(bar).not.toBeNull();
    fireEvent.click(within(bar as HTMLElement).getByTitle("清除选中"));
    expect(onSelectedHidden).toHaveBeenCalled();
  });

  it("未选中时不显示「已选择」条", async () => {
    const { bridge } = fakeTasksBridge([task("a", "任务", { projectId: "p1" })], [{ id: "p1", name: "项目一" }]);
    const { container } = renderColumn(bridge, { kind: "project", id: "p1" }, null);
    await findTitle("任务");
    expect(container.querySelector(".pw-outline-selected")).toBeNull();
  });

  it("完成/丢弃任务标题划线（R17）：is-done/is-dropped 行类 + 标题 is-struck", async () => {
    const { bridge } = fakeTasksBridge(
      [
        task("d", "已完成", { projectId: "p1", status: "done" }),
        task("x", "已丢弃", { projectId: "p1", status: "dropped" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    renderColumn(bridge, { kind: "project", id: "p1" }, undefined, { filter: "all" });
    await findTitle("已完成");
    const doneRow = rowOf("已完成");
    expect(doneRow.classList.contains("is-done")).toBe(true);
    expect(doneRow.querySelector(".pw-task-title-input")!.classList.contains("is-struck")).toBe(true);
    const dropRow = rowOf("已丢弃");
    expect(dropRow.classList.contains("is-dropped")).toBe(true);
    expect(dropRow.querySelector(".pw-task-title-input")!.classList.contains("is-struck")).toBe(true);
  });

  it("有备注任务显示备注图标与首行预览（R17）", async () => {
    const { bridge } = fakeTasksBridge(
      [task("a", "带备注", { projectId: "p1", notes: "首行预览\n第二行" })],
      [{ id: "p1", name: "项目一" }],
    );
    renderColumn(bridge, { kind: "project", id: "p1" });
    await findTitle("带备注");
    const row = rowOf("带备注");
    expect(row.querySelector(".pw-task-note-flag")).not.toBeNull();
    expect(row.querySelector(".pw-task-note-preview")?.textContent).toBe("首行预览");
  });

  it("未选中行只读精简：无占位 chip、标题为纯文本；选中行才渲染 inspector 占位与就地编辑（U10）", async () => {
    const { bridge } = fakeTasksBridge([task("a", "空字段", { projectId: "p1" })], [{ id: "p1", name: "项目一" }]);
    // 未选中：标题为纯文本 span、无灰占位 chip、无行内 inspector。
    const { container } = renderColumn(bridge, { kind: "project", id: "p1" }, null);
    const title = await findTitle("空字段");
    expect(title.classList.contains("pw-task-title-static")).toBe(true);
    expect(container.querySelector(".pw-task-chip.is-placeholder")).toBeNull();
    expect(container.querySelector(".pw-task-inspector")).toBeNull();
    cleanup();
    // 选中：行内 inspector 渲染字段占位（未设置字段以占位标签呈现，点击就地编辑）。
    const { bridge: b2 } = fakeTasksBridge([task("a", "空字段", { projectId: "p1" })], [{ id: "p1", name: "项目一" }]);
    const { container: c2 } = renderColumn(b2, { kind: "project", id: "p1" }, "a");
    await screen.findByDisplayValue("空字段");
    const bar = c2.querySelector(".pw-task-inspect-bar")!;
    expect(bar).not.toBeNull();
    expect(within(bar as HTMLElement).getByText("标签")).toBeTruthy();
  });

  it("折叠组头后该组行隐藏、统计不变（R14）", async () => {
    const projects: TaskProject[] = [
      { id: "f1", name: "分组", kind: "folder" },
      { id: "p1", name: "项目一", parentId: "f1" },
      { id: "p2", name: "项目二", parentId: "f1" },
    ];
    const { bridge } = fakeTasksBridge(
      [task("a", "任务一", { projectId: "p1" }), task("b", "任务二", { projectId: "p2" })],
      projects,
    );
    const { container } = renderColumn(bridge, { kind: "folder", id: "f1" });
    await findTitle("任务一");
    // 两组头、统计「2 个动作，2 个项目」。
    expect(container.querySelectorAll(".pw-task-group-head").length).toBe(2);
    expect(container.querySelector(".pw-outline-count")?.textContent).toBe("2 个动作，2 个项目");
    // 折叠「项目一」组头 → 任务一隐藏，任务二仍在，统计不变。
    fireEvent.click(screen.getByText("项目一").closest(".pw-task-group-head")!);
    expect(screen.queryByText("任务一")).toBeNull();
    expect(screen.getByText("任务二")).toBeTruthy();
    expect(container.querySelector(".pw-outline-count")?.textContent).toBe("2 个动作，2 个项目");
  });

  it("今日视图跨项目分组（R25）：3 个项目命中 5 条 → 3 组头、统计「5 个动作，3 个项目」", async () => {
    const projects: TaskProject[] = [
      { id: "p1", name: "项目一" },
      { id: "p2", name: "项目二" },
      { id: "p3", name: "项目三" },
    ];
    const due = "2026-07-01"; // 冻结「今天」→ 今日到期，进 Today。
    const { bridge } = fakeTasksBridge(
      [
        task("a1", "一甲", { projectId: "p1", dueDate: due }),
        task("a2", "一乙", { projectId: "p1", dueDate: due }),
        task("b1", "二甲", { projectId: "p2", dueDate: due }),
        task("b2", "二乙", { projectId: "p2", dueDate: due }),
        task("c1", "三甲", { projectId: "p3", dueDate: due }),
      ],
      projects,
    );
    const { container } = renderColumn(bridge, { kind: "today" });
    await findTitle("一甲");
    expect(container.querySelectorAll(".pw-task-group-head").length).toBe(3);
    expect(container.querySelector(".pw-outline-count")?.textContent).toBe("5 个动作，3 个项目");
    // 组头名为项目名。
    expect(screen.getByText("项目一")).toBeTruthy();
    expect(screen.getByText("项目三")).toBeTruthy();
  });

  it("今日视图无项目任务归「收件箱」组（R25）", async () => {
    const due = "2026-07-01";
    const { bridge } = fakeTasksBridge(
      [
        task("a", "有项目", { projectId: "p1", dueDate: due }),
        task("b", "无项目", { dueDate: due }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    const { container } = renderColumn(bridge, { kind: "today" });
    await findTitle("有项目");
    const heads = Array.from(container.querySelectorAll(".pw-task-group-head")).map((h) =>
      h.querySelector(".pw-task-group-name")?.textContent,
    );
    expect(heads).toContain("项目一");
    expect(heads).toContain("收件箱");
  });
});
