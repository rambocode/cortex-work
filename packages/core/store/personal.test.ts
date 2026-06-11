import { describe, expect, it } from "vitest";
import type { PersistedState, PushSettings } from "../desktop/types";
import { usePersonalStore, toPersistedState } from "./personal";

const base: PersistedState = { version: 1, projects: [], sessions: [] };

describe("hydrate 推送设置迁移", () => {
  it("旧数据（timelineSettings.push）迁移到全局 pushSettings", () => {
    const legacy = {
      ...base,
      timelineSettings: {
        summaryModel: { kind: "agent", agent: "claude", model: "haiku" },
        push: { wecom: { enabled: true, webhookUrl: "https://qyapi.weixin.qq.com/x" } },
      } as PersistedState["timelineSettings"] & { push: PushSettings },
    };
    usePersonalStore.getState().hydrate(legacy);
    expect(usePersonalStore.getState().pushSettings.wecom?.webhookUrl).toBe("https://qyapi.weixin.qq.com/x");
  });

  it("新数据 pushSettings 优先,持久化快照含两份设置", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      pushSettings: { dingtalk: { enabled: true, webhookUrl: "https://oapi.dingtalk.com/x" } },
    });
    const s = usePersonalStore.getState();
    expect(s.pushSettings.dingtalk?.enabled).toBe(true);
    const persisted = toPersistedState(s);
    expect(persisted.pushSettings).toBe(s.pushSettings);
    expect(persisted.timelineSettings).toBe(s.timelineSettings);
  });
});

describe("personal todos", () => {
  it("旧数据缺少 todos 时默认空列表并持久化", () => {
    usePersonalStore.getState().hydrate(base);
    expect(usePersonalStore.getState().todos).toEqual([]);
    expect(toPersistedState(usePersonalStore.getState()).todos).toEqual([]);
  });

  it("创建、更新、完成、删除 todo 元数据", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: 1 }],
    });

    const todo = usePersonalStore.getState().addTodo("p1", "实现续期", "/code/alpha/tasks/todo-1.md");
    expect(todo.status).toBe("open");
    expect(usePersonalStore.getState().todos).toHaveLength(1);

    usePersonalStore.getState().updateTodo(todo.id, { title: "实现 Todo 续期", status: "done" });
    expect(usePersonalStore.getState().todos[0]).toMatchObject({ title: "实现 Todo 续期", status: "done" });

    const persisted = toPersistedState(usePersonalStore.getState());
    expect(persisted.todos?.[0]?.detailPath).toBe("/code/alpha/tasks/todo-1.md");

    usePersonalStore.getState().removeTodo(todo.id);
    expect(usePersonalStore.getState().todos).toEqual([]);
  });

  it("删除项目时同步清理该项目 todos", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      projects: [
        { id: "p1", name: "alpha", path: "/code/alpha", addedAt: 1 },
        { id: "p2", name: "beta", path: "/code/beta", addedAt: 1 },
      ],
      todos: [
        { id: "t1", projectId: "p1", title: "A", status: "open", detailPath: "/code/alpha/tasks/t1.md", createdAt: 1, updatedAt: 1 },
        { id: "t2", projectId: "p2", title: "B", status: "open", detailPath: "/code/beta/tasks/t2.md", createdAt: 1, updatedAt: 1 },
      ],
    });

    usePersonalStore.getState().removeProject("p1");
    expect(usePersonalStore.getState().todos.map((todo) => todo.id)).toEqual(["t2"]);
  });
});
