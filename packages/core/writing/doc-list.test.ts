// 写作左栏文稿列表工具单测：隐藏后缀 / 重命名回填 / 排序（目录恒在前、时间与名称兜底）/ 时间格式化。
import { describe, expect, it } from "vitest";
import type { PromptNode } from "../desktop/types";
import {
  applyWritingRenameName,
  collectWritingFilePaths,
  countWritingDocs,
  findWritingDirNode,
  writingCrumbSegments,
  formatWritingDocTime,
  sortWritingTree,
  writingDisplayName,
  writingHiddenExt,
} from "./doc-list";

const meta = (path: string, birthtimeMs: number, mtimeMs: number) => ({
  path,
  birthtimeMs,
  mtimeMs,
  excerpt: "",
});

describe("writingDisplayName / writingHiddenExt", () => {
  it("隐藏 md 系后缀，保留 pdf 等非编辑格式后缀", () => {
    expect(writingDisplayName("笔记.md")).toBe("笔记");
    expect(writingDisplayName("readme.MARKDOWN")).toBe("readme");
    expect(writingDisplayName("a.mdx")).toBe("a");
    expect(writingDisplayName("论文.pdf")).toBe("论文.pdf");
    expect(writingDisplayName("目录")).toBe("目录");
  });

  it("名字里含 md 但不是后缀时不误剥", () => {
    expect(writingDisplayName("md笔记")).toBe("md笔记");
    expect(writingHiddenExt("md笔记")).toBe("");
    expect(writingHiddenExt("笔记.md")).toBe(".md");
  });
});

describe("applyWritingRenameName", () => {
  it("输入不带后缀时补回原后缀", () => {
    expect(applyWritingRenameName("旧名.md", "新名")).toBe("新名.md");
    expect(applyWritingRenameName("a.mdx", " b ")).toBe("b.mdx");
  });

  it("输入已带 md 系后缀时尊重输入，不叠加", () => {
    expect(applyWritingRenameName("旧名.md", "新名.mdx")).toBe("新名.mdx");
  });

  it("名字里带点但不是 md 后缀时仍补后缀（左栏隐藏的就是它）", () => {
    expect(applyWritingRenameName("报告.md", "报告.v2")).toBe("报告.v2.md");
  });

  it("非 md 文件与目录原样提交", () => {
    expect(applyWritingRenameName("论文.pdf", "新论文.pdf")).toBe("新论文.pdf");
    expect(applyWritingRenameName("目录", "新目录")).toBe("新目录");
  });
});

describe("sortWritingTree", () => {
  const tree: PromptNode = {
    name: "root",
    path: "/r",
    kind: "dir",
    children: [
      { name: "b.md", path: "/r/b.md", kind: "file" },
      { name: "z-dir", path: "/r/z-dir", kind: "dir", children: [] },
      { name: "a.md", path: "/r/a.md", kind: "file" },
      { name: "a-dir", path: "/r/a-dir", kind: "dir", children: [] },
    ],
  };
  const metaByPath = {
    "/r/a.md": meta("/r/a.md", 300, 100),
    "/r/b.md": meta("/r/b.md", 100, 300),
  };

  it("目录恒在文件之前，名称升序", () => {
    const out = sortWritingTree(tree, { key: "name", order: "asc", metaByPath });
    expect(out.children?.map((c) => c.name)).toEqual(["a-dir", "z-dir", "a.md", "b.md"]);
  });

  it("降序时目录仍在前，组内倒序", () => {
    const out = sortWritingTree(tree, { key: "name", order: "desc", metaByPath });
    expect(out.children?.map((c) => c.name)).toEqual(["z-dir", "a-dir", "b.md", "a.md"]);
  });

  it("按创建时间排序只作用于文件，目录仍按名称", () => {
    const out = sortWritingTree(tree, { key: "created", order: "desc", metaByPath });
    expect(out.children?.map((c) => c.name)).toEqual(["z-dir", "a-dir", "a.md", "b.md"]);
  });

  it("按修改时间排序", () => {
    const out = sortWritingTree(tree, { key: "updated", order: "desc", metaByPath });
    expect(out.children?.map((c) => c.name)).toEqual(["z-dir", "a-dir", "b.md", "a.md"]);
  });

  it("缺元信息按 0 兜底、时间相同按名称，顺序稳定", () => {
    const out = sortWritingTree(tree, { key: "updated", order: "asc", metaByPath: {} });
    expect(out.children?.map((c) => c.name)).toEqual(["a-dir", "z-dir", "a.md", "b.md"]);
  });

  it("递归排序子目录且不改原树", () => {
    const nested: PromptNode = {
      name: "root",
      path: "/r",
      kind: "dir",
      children: [
        {
          name: "d",
          path: "/r/d",
          kind: "dir",
          children: [
            { name: "y.md", path: "/r/d/y.md", kind: "file" },
            { name: "x.md", path: "/r/d/x.md", kind: "file" },
          ],
        },
      ],
    };
    const out = sortWritingTree(nested, { key: "name", order: "asc", metaByPath: {} });
    expect(out.children?.[0]?.children?.map((c) => c.name)).toEqual(["x.md", "y.md"]);
    expect(nested.children?.[0]?.children?.map((c) => c.name)).toEqual(["y.md", "x.md"]);
  });
});

describe("formatWritingDocTime", () => {
  it("格式化为 YYYY/MM/DD HH:mm", () => {
    const ms = new Date(2026, 7, 12, 9, 5).getTime();
    expect(formatWritingDocTime(ms)).toBe("2026/08/12 09:05");
  });

  it("缺失/非法回空串", () => {
    expect(formatWritingDocTime(undefined)).toBe("");
    expect(formatWritingDocTime(0)).toBe("");
    expect(formatWritingDocTime(Number.NaN)).toBe("");
  });
});

describe("findWritingDirNode / writingCrumbSegments / countWritingDocs", () => {
  const tree: PromptNode = {
    name: "root",
    path: "/r",
    kind: "dir",
    children: [
      { name: "a.md", path: "/r/a.md", kind: "file" },
      {
        name: "d",
        path: "/r/d",
        kind: "dir",
        children: [
          { name: "b.md", path: "/r/d/b.md", kind: "file" },
          {
            name: "deep",
            path: "/r/d/deep",
            kind: "dir",
            children: [{ name: "c.md", path: "/r/d/deep/c.md", kind: "file" }],
          },
        ],
      },
    ],
  };

  it("按绝对路径定位目录节点；文件路径与不存在路径回 null", () => {
    expect(findWritingDirNode(tree, "/r/d")?.name).toBe("d");
    expect(findWritingDirNode(tree, "/r/d/deep")?.name).toBe("deep");
    expect(findWritingDirNode(tree, "/r")?.name).toBe("root");
    expect(findWritingDirNode(tree, "/r/a.md")).toBeNull();
    expect(findWritingDirNode(tree, "/r/nope")).toBeNull();
    expect(findWritingDirNode(null, "/r")).toBeNull();
  });

  it("面包屑层级为相对空间根的片段；在根层为空", () => {
    expect(writingCrumbSegments("/r", "/r")).toEqual([]);
    expect(writingCrumbSegments("/r/", "/r/d/deep")).toEqual(["d", "deep"]);
    expect(writingCrumbSegments("/r", "/other/x")).toEqual([]);
  });

  it("目录文档数递归统计（含子目录）", () => {
    expect(countWritingDocs(tree)).toBe(3);
    expect(countWritingDocs(findWritingDirNode(tree, "/r/d"))).toBe(2);
    expect(countWritingDocs(findWritingDirNode(tree, "/r/d/deep"))).toBe(1);
    expect(countWritingDocs(null)).toBe(0);
  });
});

describe("collectWritingFilePaths", () => {
  it("递归收集文件路径，忽略目录本身", () => {
    const tree: PromptNode = {
      name: "root",
      path: "/r",
      kind: "dir",
      children: [
        { name: "a.md", path: "/r/a.md", kind: "file" },
        {
          name: "d",
          path: "/r/d",
          kind: "dir",
          children: [{ name: "b.md", path: "/r/d/b.md", kind: "file" }],
        },
      ],
    };
    expect(collectWritingFilePaths(tree)).toEqual(["/r/a.md", "/r/d/b.md"]);
    expect(collectWritingFilePaths(null)).toEqual([]);
  });
});
