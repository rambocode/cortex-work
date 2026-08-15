// 文件检索引擎单测:argv 构造(成对负 glob / -- 分隔)、顶层目录轮询采样、rg JSON 解析、
// 错误分类、树构建与空目录补充,以及跑真 rg 二进制的集成用例(mtime 逆序 / .gitignore 尊重)。
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it, vi } from "vitest";

// fs-search 经 ../paths 触电 electron:mock 掉 app.getPath(documents 指到临时目录,spill 测试用)。
const tmpBase = mkdtempSync(join(tmpdir(), "fs-search-test-"));
vi.mock("electron", () => ({ app: { getPath: () => tmpBase } }));

import {
  FsSearchError,
  MATCH_LINE_MAX_CHARS,
  buildContentSearchArgs,
  buildFileListArgs,
  buildTreeFromPaths,
  classifyExecError,
  excludeGlobs,
  findEmptyDirs,
  parseContentMatches,
  parseFileList,
  runRg,
  sampleAcrossTopLevel,
  saveSearchSpill,
  topLevelSegment,
} from "./fs-search";

afterAll(() => rmSync(tmpBase, { recursive: true, force: true }));

describe("argv 构造", () => {
  it("排除目录成对生成两条负 glob(裸形态剪枝 + /** 形态兜根在目录内)", () => {
    const globs = excludeGlobs();
    expect(globs).toContain("--glob=!**/.git");
    expect(globs).toContain("--glob=!**/.git/**");
    expect(globs).toContain("--glob=!**/node_modules");
    expect(globs).toContain("--glob=!**/node_modules/**");
    expect(globs.length % 2).toBe(0);
  });

  it("文件清单:--files + 隐藏文件 + mtime 逆序;内容搜索:词经 --regexp= 传递、根在 -- 之后", () => {
    const list = buildFileListArgs();
    expect(list).toContain("--files");
    expect(list).toContain("--hidden");
    expect(list).toContain("--sortr=modified");
    const search = buildContentSearchArgs("-rf ./");
    expect(search).toContain("--fixed-strings");
    expect(search).toContain("--regexp=-rf ./"); // 前导连字符不会被吃成 flag
    expect(search.slice(-2)).toEqual(["--", "."]);
  });
});

describe("sampleAcrossTopLevel", () => {
  it("每个顶层项先各得一席再轮第二席,组内保持原序", () => {
    const items = ["a/1", "a/2", "a/3", "b/1", "b/2", "c/1"];
    const sample = sampleAcrossTopLevel(items, (x) => x, 4);
    expect(sample.items).toEqual(["a/1", "a/2", "b/1", "c/1"]);
    expect(sample.shown).toBe(3);
    expect(sample.total).toBe(3);
  });

  it("扁平结果(无子目录)退化为取头部;超出组数时 shown < total", () => {
    const flat = ["x", "y", "z"];
    expect(sampleAcrossTopLevel(flat, (x) => x, 2).items).toEqual(["x", "y"]);
    const wide = ["a/1", "b/1", "c/1", "d/1"];
    const sample = sampleAcrossTopLevel(wide, (x) => x, 2);
    expect(sample.items).toEqual(["a/1", "b/1"]);
    expect(sample.shown).toBe(2);
    expect(sample.total).toBe(4);
  });

  it("topLevelSegment:首段为顶层项,无分隔符自成一组", () => {
    expect(topLevelSegment("src/a/b.ts")).toBe("src");
    expect(topLevelSegment("README.md")).toBe("README.md");
  });
});

describe("输出解析", () => {
  it("parseFileList:截断到 cap 并报全量", () => {
    const { paths, total } = parseFileList("a\nb\nc\n", 2);
    expect(paths).toEqual(["a", "b"]);
    expect(total).toBe(3);
  });

  it("parseContentMatches:按文件分组保持顺序,行文本 trimEnd + 字符截断,坏行跳过", () => {
    const long = "x".repeat(MATCH_LINE_MAX_CHARS + 50);
    const stdout = [
      JSON.stringify({ type: "begin", data: { path: { text: "a.ts" } } }),
      JSON.stringify({ type: "match", data: { path: { text: "a.ts" }, lines: { text: "hit one  \n" }, line_number: 3 } }),
      "not-json",
      JSON.stringify({ type: "match", data: { path: { text: "sub/b.ts" }, lines: { text: `${long}\n` }, line_number: 7 } }),
      JSON.stringify({ type: "end", data: {} }),
    ].join("\n");
    const files = parseContentMatches(stdout, "/root");
    expect(files.map((f) => f.rel)).toEqual(["a.ts", "sub/b.ts"]);
    expect(files[0]!.path).toBe(join("/root", "a.ts"));
    expect(files[0]!.lines).toEqual([{ line: 3, text: "hit one" }]);
    expect(files[1]!.lines[0]!.text.length).toBe(MATCH_LINE_MAX_CHARS);
  });
});

describe("错误分类", () => {
  const err = (props: object) => Object.assign(new Error("boom"), props);
  it("maxBuffer 超限 → OUTPUT_OVERFLOW(超限即报错,不静默解析半截流)", () => {
    expect(classifyExecError("grep", err({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), "").code).toBe(
      "OUTPUT_OVERFLOW",
    );
  });
  it("超时/信号 → ABORTED;pattern 报错 → INVALID_PATTERN;其余 → SEARCH_FAILED", () => {
    expect(classifyExecError("grep", err({ killed: true, signal: "SIGTERM" }), "").code).toBe("ABORTED");
    expect(classifyExecError("grep", err({ code: 2 }), "rg: regex parse error: unclosed group").code).toBe(
      "INVALID_PATTERN",
    );
    expect(classifyExecError("grep", err({ code: 2 }), "something else").code).toBe("SEARCH_FAILED");
  });
});

describe("buildTreeFromPaths", () => {
  it("路径清单成树:目录在前字典序,extraDirs 补出空文件夹", () => {
    const tree = buildTreeFromPaths("/r", "r", ["b.ts", "sub/a.ts"], ["empty"]);
    expect(tree.children!.map((c) => `${c.kind}:${c.name}`)).toEqual(["dir:empty", "dir:sub", "file:b.ts"]);
    const sub = tree.children!.find((c) => c.name === "sub")!;
    expect(sub.children!.map((c) => c.name)).toEqual(["a.ts"]);
    expect(sub.children![0]!.path).toBe(join("/r", "sub/a.ts"));
  });
});

describe("集成(真 rg 二进制)", () => {
  const root = join(tmpBase, "proj");

  function setup(): void {
    mkdirSync(join(root, ".git"), { recursive: true }); // 激活 .gitignore 语义
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
    mkdirSync(join(root, "newdir"), { recursive: true }); // 真空目录
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(root, "ignored.txt"), "needle hidden by gitignore\n");
    writeFileSync(join(root, "node_modules/pkg/dep.js"), "needle in excluded dir\n");
    writeFileSync(join(root, "old.txt"), "plain needle line\n");
    writeFileSync(join(root, "sub/new.txt"), "another needle here\n");
    // mtime:sub/new.txt 最新,old.txt 最旧 → 清单应 new 在前(mtime 逆序契约)。
    utimesSync(join(root, "old.txt"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    utimesSync(join(root, "sub/new.txt"), new Date(2030, 0, 1), new Date(2030, 0, 1));
  }

  it("文件清单:mtime 逆序、尊重 .gitignore、排除 VCS/重型目录;内容搜索命中带行号;零结果不报错", async () => {
    setup();
    const list = await runRg(buildFileListArgs(), root, "glob");
    const { paths } = parseFileList(list.stdout, 100);
    expect(paths[0]).toBe(join("sub", "new.txt"));
    expect(paths).toContain("old.txt");
    expect(paths).toContain(".gitignore");
    expect(paths).not.toContain("ignored.txt");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);

    const search = await runRg(buildContentSearchArgs("NEEDLE"), root, "grep");
    const files = parseContentMatches(search.stdout, root);
    expect(files.map((f) => f.rel).sort()).toEqual(["old.txt", join("sub", "new.txt")]);
    expect(files.find((f) => f.rel === "old.txt")!.lines).toEqual([{ line: 1, text: "plain needle line" }]);

    const none = await runRg(buildContentSearchArgs("absent-term-xyz"), root, "grep");
    expect(none.noMatches).toBe(true);
  }, 30_000);

  it("findEmptyDirs 只收真空目录;非法 pattern 分类为 INVALID_PATTERN", async () => {
    const empties = await findEmptyDirs(root);
    expect(empties).toContain("newdir");
    expect(empties).not.toContain("sub");
    expect(empties.some((p) => p.includes("node_modules"))).toBe(false);

    // 用 --glob 通道触发 rg 的 pattern 报错(内容搜索是 fixed-strings,不会非法)。
    await expect(runRg(["--files", "--glob={bad", "--sortr=modified"], root, "glob")).rejects.toMatchObject({
      code: "INVALID_PATTERN",
    });
  }, 30_000);

  it("spill:写入 Documents/cortex/.search-results 并返回路径", async () => {
    const path = await saveSearchSpill("content-search", "full result body");
    expect(path).toBeTruthy();
    expect(path!).toContain(join("cortex", ".search-results"));
  });

  it("FsSearchError 携带分类码", () => {
    const e = new FsSearchError("x", "ABORTED");
    expect(e.code).toBe("ABORTED");
    expect(e.name).toBe("FsSearchError");
  });
});
