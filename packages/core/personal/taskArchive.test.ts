import { describe, it, expect, vi } from "vitest";
import {
  archiveTaskFiles,
  buildArchivePrompt,
  groupTaskFiles,
  isArchiveFileName,
  isoWeek,
  periodKey,
  taskFileTime,
  unregisteredTaskFiles,
} from "./taskArchive";
import type { DesktopBridge } from "../desktop/bridge";
import type { TaskFileInfo, TodoMeta } from "../desktop/types";

function file(name: string, mtimeMs = 0): TaskFileInfo {
  return { name, path: `/proj/tasks/${name}`, mtimeMs };
}

function todo(partial: Partial<TodoMeta> & { detailPath: string }): TodoMeta {
  return {
    id: partial.id ?? partial.detailPath,
    projectId: "p1",
    title: partial.title ?? "t",
    status: partial.status ?? "open",
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe("taskFileTime", () => {
  it("文件名 YYYY-MM-DD 前缀优先于 mtime", () => {
    const ts = taskFileTime(file("2026-06-12-foo.md", 999));
    expect(new Date(ts).getFullYear()).toBe(2026);
    expect(new Date(ts).getMonth()).toBe(5);
    expect(new Date(ts).getDate()).toBe(12);
  });

  it("无日期前缀回退 mtime", () => {
    expect(taskFileTime(file("lessons.md", 1234))).toBe(1234);
  });
});

describe("isoWeek / periodKey", () => {
  it("ISO 周:周一起始,跨年周归属正确", () => {
    // 2026-01-01 是周四 → 2026-W01
    expect(isoWeek(new Date(2026, 0, 1).getTime())).toEqual({ year: 2026, week: 1 });
    // 2025-12-29 是周一,与 2026-01-01 同周 → ISO 年 2026 第 1 周
    expect(isoWeek(new Date(2025, 11, 29).getTime())).toEqual({ year: 2026, week: 1 });
    // 2026-06-12 是周五 → 第 24 周
    expect(isoWeek(new Date(2026, 5, 12).getTime())).toEqual({ year: 2026, week: 24 });
  });

  it("periodKey 三种粒度", () => {
    const ts = new Date(2026, 5, 12).getTime();
    expect(periodKey(ts, "week")).toBe("2026-W24");
    expect(periodKey(ts, "month")).toBe("2026-06");
    expect(periodKey(ts, "year")).toBe("2026");
  });
});

describe("isArchiveFileName", () => {
  it("识别周/月/年归档文件名", () => {
    expect(isArchiveFileName("2026-W24.md")).toBe(true);
    expect(isArchiveFileName("2026-06.md")).toBe(true);
    expect(isArchiveFileName("2026.md")).toBe(true);
    expect(isArchiveFileName("2026-06-12-fix-login.md")).toBe(false);
    expect(isArchiveFileName("lessons.md")).toBe(false);
  });
});

describe("groupTaskFiles", () => {
  it("按周分组,新周期在前,组内按时间升序,归档文件排除", () => {
    const files = [
      file("2026-06-12-b.md"), // W24 周五
      file("2026-06-08-a.md"), // W24 周一
      file("2026-06-03-c.md"), // W23
      file("2026-W23.md"), // 归档产物,排除
    ];
    const groups = groupTaskFiles(files, "week");
    expect(groups.map((g) => g.key)).toEqual(["2026-W24", "2026-W23"]);
    expect(groups[0]?.files.map((f) => f.name)).toEqual(["2026-06-08-a.md", "2026-06-12-b.md"]);
    expect(groups[1]?.files.map((f) => f.name)).toEqual(["2026-06-03-c.md"]);
  });

  it("无日期前缀的文件按 mtime 归组", () => {
    const groups = groupTaskFiles([file("lessons.md", new Date(2026, 4, 1).getTime())], "month");
    expect(groups[0]?.key).toBe("2026-05");
  });
});

describe("unregisteredTaskFiles", () => {
  it("排除已登记 todo 的文件与归档文件", () => {
    const files = [file("t1.md"), file("free.md"), file("2026-W20.md")];
    const todos = [todo({ detailPath: "/proj/tasks/t1.md" })];
    expect(unregisteredTaskFiles(files, todos).map((f) => f.name)).toEqual(["free.md"]);
  });
});

describe("archiveTaskFiles", () => {
  function setup(opts?: { todos?: TodoMeta[]; completeImpl?: () => Promise<string>; existingArchive?: string }) {
    const fs = new Map<string, string>([
      ["/proj/tasks/2026-06-08-a.md", "# 任务A\n做了 A"],
      ["/proj/tasks/2026-06-12-b.md", "# 任务B\n做了 B"],
    ]);
    if (opts?.existingArchive) fs.set("/proj/tasks/archive/2026-W24.md", opts.existingArchive);
    const deleted: string[] = [];
    const bridge = {
      readFile: async (path: string) => {
        if (!fs.has(path)) throw new Error(`ENOENT: ${path}`);
        return { content: fs.get(path)!, truncated: false };
      },
      writeFile: async (path: string, content: string) => {
        fs.set(path, content);
      },
      deleteFile: async (path: string) => {
        fs.delete(path);
        deleted.push(path);
      },
    } as unknown as DesktopBridge;
    const complete = vi.fn<(bridge: DesktopBridge, prompt: string) => Promise<string>>(
      opts?.completeImpl ?? (async () => "# 2026-W24 任务归档\n\n总结内容"),
    );
    const group = { key: "2026-W24", files: [file("2026-06-08-a.md"), file("2026-06-12-b.md")] };
    return { fs, deleted, bridge, complete, group };
  }

  it("完整流程:总结写入 archive/,原文件删除,done todo 上报移除", async () => {
    const { fs, deleted, bridge, complete, group } = setup();
    const todos = [todo({ id: "tb", detailPath: "/proj/tasks/2026-06-12-b.md", status: "done" })];
    const result = await archiveTaskFiles({
      bridge,
      projectPath: "/proj",
      projectName: "demo",
      group,
      todos,
      complete,
    });
    expect(result.archivePath).toBe("/proj/tasks/archive/2026-W24.md");
    expect(result.archivedCount).toBe(2);
    expect(result.skippedOpen).toBe(0);
    expect(result.removedTodoIds).toEqual(["tb"]);
    expect(fs.get("/proj/tasks/archive/2026-W24.md")).toContain("总结内容");
    expect(deleted.sort()).toEqual(["/proj/tasks/2026-06-08-a.md", "/proj/tasks/2026-06-12-b.md"]);
    // prompt 包含文件内容与项目名
    expect(complete.mock.calls[0]?.[1] ?? "").toContain("任务A");
    expect(complete.mock.calls[0]?.[1] ?? "").toContain("demo");
  });

  it("未完成(open)任务文件跳过,不读不删", async () => {
    const { deleted, bridge, complete, group } = setup();
    const todos = [todo({ detailPath: "/proj/tasks/2026-06-08-a.md", status: "open" })];
    const result = await archiveTaskFiles({
      bridge,
      projectPath: "/proj",
      projectName: "demo",
      group,
      todos,
      complete,
    });
    expect(result.skippedOpen).toBe(1);
    expect(result.archivedCount).toBe(1);
    expect(deleted).toEqual(["/proj/tasks/2026-06-12-b.md"]);
    expect(complete.mock.calls[0]?.[1] ?? "").not.toContain("任务A");
  });

  it("全部为 open 时抛错,不动任何文件", async () => {
    const { deleted, bridge, complete, group } = setup();
    const todos = [
      todo({ detailPath: "/proj/tasks/2026-06-08-a.md", status: "open" }),
      todo({ detailPath: "/proj/tasks/2026-06-12-b.md", status: "open" }),
    ];
    await expect(
      archiveTaskFiles({ bridge, projectPath: "/proj", projectName: "demo", group, todos, complete }),
    ).rejects.toThrow("没有可归档");
    expect(deleted).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it("总结失败/为空时中止,不删任何文件", async () => {
    for (const completeImpl of [async () => "", async (): Promise<string> => Promise.reject(new Error("模型超时"))]) {
      const { fs, deleted, bridge, complete, group } = setup({ completeImpl });
      await expect(
        archiveTaskFiles({ bridge, projectPath: "/proj", projectName: "demo", group, todos: [], complete }),
      ).rejects.toThrow();
      expect(deleted).toEqual([]);
      expect(fs.has("/proj/tasks/archive/2026-W24.md")).toBe(false);
    }
  });

  it("同名归档已存在时追加而非覆盖", async () => {
    const { fs, bridge, complete, group } = setup({ existingArchive: "# 旧归档\n旧内容" });
    await archiveTaskFiles({ bridge, projectPath: "/proj", projectName: "demo", group, todos: [], complete });
    const merged = fs.get("/proj/tasks/archive/2026-W24.md")!;
    expect(merged).toContain("旧内容");
    expect(merged).toContain("总结内容");
    expect(merged.indexOf("旧内容")).toBeLessThan(merged.indexOf("总结内容"));
  });
});

describe("buildArchivePrompt", () => {
  it("包含周期、项目名与文件分隔", () => {
    const p = buildArchivePrompt("demo", "2026-W24", [{ name: "a.md", content: "正文A" }]);
    expect(p).toContain("2026-W24");
    expect(p).toContain("demo");
    expect(p).toContain("===== FILE: a.md =====");
    expect(p).toContain("正文A");
  });
});
