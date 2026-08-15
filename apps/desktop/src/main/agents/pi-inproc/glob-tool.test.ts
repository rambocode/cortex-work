// glob 工具单测:argv 构造、超限 footer 文案,以及跑真 rg 二进制的 execute 集成用例
// (mtime 逆序、--no-ignore 连被 ignore 文件一起发现、采样 + spill、错误分类)。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveRgPath } from "../../ipc/fs-search-core";
import { buildGlobArgs, createGlobTool, formatGlobOverCap, GLOB_TOOL_NAME } from "./glob-tool";

const root = mkdtempSync(join(tmpdir(), "glob-tool-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// execute 的 ToolDefinition 签名有五个位置参,测试里只关心 params/signal。
async function run(tool: ReturnType<typeof createGlobTool>, params: unknown): Promise<string> {
  const result = (await tool.execute("call-1", params as never, undefined as never, undefined as never, undefined as never)) as {
    content: Array<{ type: string; text: string }>;
  };
  return result.content[0]!.text;
}

describe("buildGlobArgs", () => {
  it("含 --no-ignore/--hidden/--sortr=modified 与成对 VCS 负 glob;path 走 -- 之后", () => {
    const args = buildGlobArgs("**/*.ts", "sub");
    expect(args).toContain("--files");
    expect(args).toContain("--glob=**/*.ts");
    expect(args).toContain("--no-ignore");
    expect(args).toContain("--hidden");
    expect(args).toContain("--sortr=modified");
    expect(args).toContain("--glob=!**/.git");
    expect(args).toContain("--glob=!**/.git/**");
    expect(args.slice(-2)).toEqual(["--", "sub"]);
    expect(buildGlobArgs("*.md")).not.toContain("--");
  });
});

describe("formatGlobOverCap", () => {
  it("采样说明 + spill 恢复路径;扁平结果 basis 退化为句号;无 spill 给收窄提示", () => {
    const sampled = formatGlobOverCap({ items: ["a/1", "b/1"], shown: 2, total: 5 }, 40, "/tmp/x.txt");
    expect(sampled).toContain("Showing 2 of 40 paths, sampled across 2 of the 5 top-level entries");
    expect(sampled).toContain("Narrow path to inspect a specific subtree.");
    expect(sampled).toContain("Full sorted result stored at: /tmp/x.txt");
    const flat = formatGlobOverCap({ items: ["x", "y"], shown: 2, total: 4 }, 4, undefined);
    expect(flat).toContain("Showing 2 of 4 paths.");
    expect(flat).toContain("could not be saved; narrow pattern or path");
  });
});

describe("execute(真 rg 二进制)", () => {
  const rgPath = resolveRgPath();

  function setup(): void {
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(root, "ignored.ts"), "");
    writeFileSync(join(root, "src/a.ts"), "");
    writeFileSync(join(root, "lib/b.ts"), "");
    writeFileSync(join(root, "readme.md"), "");
    utimesSync(join(root, "src/a.ts"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    utimesSync(join(root, "lib/b.ts"), new Date(2030, 0, 1), new Date(2030, 0, 1));
  }

  it("匹配 pattern、mtime 逆序、--no-ignore 连被 ignore 的文件一起返回、.git 永不出现", async () => {
    setup();
    const tool = createGlobTool(root, rgPath);
    expect(tool.name).toBe(GLOB_TOOL_NAME);
    const text = await run(tool, { pattern: "*.ts" });
    const lines = text.split("\n");
    expect(lines[0]).toBe(join("lib", "b.ts")); // 最新的在前
    expect(lines).toContain(join("src", "a.ts"));
    expect(lines).toContain("ignored.ts"); // --no-ignore 契约
    expect(text).not.toContain(".git");
    expect(await run(tool, { pattern: "*.nope" })).toBe("No files found");
  }, 30_000);

  it("超限:顶层目录轮询采样 + spill 全量;path 参数收窄检索根", async () => {
    // 追加同顶层目录内的多个文件:顶层项数 < 路径数,采样分支才会触发
    //(每条路径各自成顶层项时按参照语义正确退化为取头部)。
    writeFileSync(join(root, "src/c.ts"), "");
    writeFileSync(join(root, "lib/e.ts"), "");
    const tool = createGlobTool(root, rgPath, 2);
    const text = await run(tool, { pattern: "*.ts" });
    expect(text).toContain("Showing 2 of ");
    expect(text).toContain("sampled across 2 of the 3 top-level entries");
    const spillMatch = /stored at: (\S+)\./.exec(text);
    expect(spillMatch).toBeTruthy();
    // spill 是全量:未入选内联页的旧文件也在
    const spilled = readFileSync(spillMatch![1]!, "utf8");
    expect(spilled).toContain(join("src", "a.ts"));

    const scoped = await run(createGlobTool(root, rgPath), { pattern: "*.ts", path: "src" });
    expect(scoped.split("\n").sort()).toEqual([join("src", "a.ts"), join("src", "c.ts")]);
  }, 30_000);

  it("空 pattern 拒绝;非法 pattern 抛 INVALID_PATTERN 分类错误", async () => {
    const tool = createGlobTool(root, rgPath);
    await expect(run(tool, { pattern: "  " })).rejects.toThrow(/pattern must be a non-empty string/);
    await expect(run(tool, { pattern: "{bad" })).rejects.toThrow(/\[INVALID_PATTERN\]/);
  }, 30_000);
});
