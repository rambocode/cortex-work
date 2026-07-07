// 写作文件树 CRUD 与路径工具单测:重名预检、名称非法、旧壳降级、路径拼接。
import { describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import {
  basename,
  createDir,
  createFile,
  deleteNode,
  filterWritingTree,
  firstMarkdownFile,
  joinPath,
  parentPath,
  renameNode,
} from "./file-tree";

function makeBridge(overrides: Partial<DesktopBridge>): DesktopBridge {
  return overrides as DesktopBridge;
}

describe("path helpers", () => {
  it("basename 取末段(兼容尾斜杠/反斜杠)", () => {
    expect(basename("/a/b/c.md")).toBe("c.md");
    expect(basename("/a/b/")).toBe("b");
    expect(basename("C:\\a\\b")).toBe("b");
  });
  it("parentPath 取父目录", () => {
    expect(parentPath("/a/b/c.md")).toBe("/a/b");
    expect(parentPath("/a/b/")).toBe("/a");
  });
  it("joinPath 去重分隔符", () => {
    expect(joinPath("/a/b", "c.md")).toBe("/a/b/c.md");
    expect(joinPath("/a/b/", "c.md")).toBe("/a/b/c.md");
  });
});

describe("createFile", () => {
  it("目标不存在 → 写入空文件并回目标路径", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const bridge = makeBridge({ fileExists: vi.fn().mockResolvedValue(false), writeFile });
    const res = await createFile(bridge, "/root", "new.md");
    expect(res.ok).toBe(true);
    expect(res.path).toBe("/root/new.md");
    expect(writeFile).toHaveBeenCalledWith("/root/new.md", "");
  });

  it("重名 → 拒绝(error=exists)且不写盘", async () => {
    const writeFile = vi.fn();
    const bridge = makeBridge({ fileExists: vi.fn().mockResolvedValue(true), writeFile });
    const res = await createFile(bridge, "/root", "dup.md");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("exists");
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("名称非法(空/含分隔符)→ error=invalid", async () => {
    const bridge = makeBridge({ fileExists: vi.fn().mockResolvedValue(false), writeFile: vi.fn() });
    expect((await createFile(bridge, "/root", "  ")).error).toBe("invalid");
    expect((await createFile(bridge, "/root", "a/b")).error).toBe("invalid");
  });

  it("旧壳无 fileExists → 不预检(退化 false),仍尝试写盘", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const bridge = makeBridge({ writeFile });
    const res = await createFile(bridge, "/root", "x.md");
    expect(res.ok).toBe(true);
    expect(writeFile).toHaveBeenCalled();
  });
});

describe("createDir", () => {
  it("mkdir 缺失 → unsupported", async () => {
    const res = await createDir(makeBridge({}), "/root", "sub");
    expect(res.error).toBe("unsupported");
  });
  it("正常建目录", async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const bridge = makeBridge({ mkdir, fileExists: vi.fn().mockResolvedValue(false) });
    const res = await createDir(bridge, "/root", "sub");
    expect(res.ok).toBe(true);
    expect(mkdir).toHaveBeenCalledWith("/root/sub");
  });
});

describe("renameNode", () => {
  it("正常重命名 → 调 renameEntry(from,to)", async () => {
    const renameEntry = vi.fn().mockResolvedValue(undefined);
    const bridge = makeBridge({ renameEntry, fileExists: vi.fn().mockResolvedValue(false) });
    const res = await renameNode(bridge, "/root/a.md", "b.md");
    expect(res.ok).toBe(true);
    expect(res.path).toBe("/root/b.md");
    expect(renameEntry).toHaveBeenCalledWith("/root/a.md", "/root/b.md");
  });

  it("同名 → no-op 成功,不调 renameEntry", async () => {
    const renameEntry = vi.fn();
    const bridge = makeBridge({ renameEntry, fileExists: vi.fn() });
    const res = await renameNode(bridge, "/root/a.md", "a.md");
    expect(res.ok).toBe(true);
    expect(renameEntry).not.toHaveBeenCalled();
  });

  it("目标已存在 → error=exists,不调 renameEntry", async () => {
    const renameEntry = vi.fn();
    const bridge = makeBridge({ renameEntry, fileExists: vi.fn().mockResolvedValue(true) });
    const res = await renameNode(bridge, "/root/a.md", "taken.md");
    expect(res.error).toBe("exists");
    expect(renameEntry).not.toHaveBeenCalled();
  });

  it("renameEntry 缺失 → unsupported", async () => {
    const res = await renameNode(makeBridge({}), "/root/a.md", "b.md");
    expect(res.error).toBe("unsupported");
  });
});

describe("deleteNode", () => {
  it("调 deleteEntry", async () => {
    const deleteEntry = vi.fn().mockResolvedValue(undefined);
    const res = await deleteNode(makeBridge({ deleteEntry }), "/root/a.md");
    expect(res.ok).toBe(true);
    expect(deleteEntry).toHaveBeenCalledWith("/root/a.md");
  });
  it("deleteEntry 缺失 → unsupported", async () => {
    const res = await deleteNode(makeBridge({}), "/root/a.md");
    expect(res.error).toBe("unsupported");
  });
  it("底层抛错 → error=failed 且带 message", async () => {
    const deleteEntry = vi.fn().mockRejectedValue(new Error("boom"));
    const res = await deleteNode(makeBridge({ deleteEntry }), "/root/a.md");
    expect(res.error).toBe("failed");
    expect(res.message).toBe("boom");
  });
});

describe("filterWritingTree / firstMarkdownFile", () => {
  // 构造树:根下 img 目录(仅图片)、docs 目录(含 md + png)、顶层 pdf/md/txt。
  const tree = {
    name: "root",
    path: "/root",
    kind: "dir" as const,
    children: [
      {
        name: "img",
        path: "/root/img",
        kind: "dir" as const,
        children: [{ name: "a.png", path: "/root/img/a.png", kind: "file" as const }],
      },
      {
        name: "docs",
        path: "/root/docs",
        kind: "dir" as const,
        children: [
          { name: "b.png", path: "/root/docs/b.png", kind: "file" as const },
          { name: "inner.md", path: "/root/docs/inner.md", kind: "file" as const },
        ],
      },
      { name: "paper.pdf", path: "/root/paper.pdf", kind: "file" as const },
      { name: "note.txt", path: "/root/note.txt", kind: "file" as const },
      { name: "top.md", path: "/root/top.md", kind: "file" as const },
    ],
  };

  it("只保留 md/pdf 文件;仅图片的目录整体隐藏;txt/png 滤掉", () => {
    const filtered = filterWritingTree(tree);
    const names = (filtered.children ?? []).map((c) => c.name);
    expect(names).toEqual(["docs", "paper.pdf", "top.md"]);
    const docs = filtered.children!.find((c) => c.name === "docs")!;
    expect((docs.children ?? []).map((c) => c.name)).toEqual(["inner.md"]);
  });

  it("firstMarkdownFile:本层 md 优先于子目录深入;pdf 不算", () => {
    expect(firstMarkdownFile(filterWritingTree(tree))).toBe("/root/top.md");
    // 去掉顶层 md 后,深入 docs 找到 inner.md
    const noTop = { ...tree, children: tree.children.filter((c) => c.name !== "top.md") };
    expect(firstMarkdownFile(filterWritingTree(noTop))).toBe("/root/docs/inner.md");
    // 全无 md → null
    const none = { name: "r", path: "/r", kind: "dir" as const, children: [] };
    expect(firstMarkdownFile(none)).toBeNull();
  });
});
