// 研究报告归档落盘的行为契约（默认轮，真临时目录）。
//
// 用真 fs 而不是假替身：这里要验证的恰恰是「目录不存在时自动建、同名文件不被覆盖、
// 撞名递增」这些只有真文件系统才能证伪的性质。
//
// electron 被整体桩掉：resolveResearchArchiveDir 的 Documents 兜底经 ../paths 的
// documentsCortexDir() → app.getPath("documents")，桩成临时目录即可（与 ipc/fs-rename.test.ts 同法）。
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ documents: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => mocks.documents },
}));

import { archiveResearchReport, resolveResearchArchiveDir } from "./report-archive";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cre-archive-"));
  mocks.documents = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function listArchive(dir: string): Promise<string[]> {
  return (await fsp.readdir(dir)).sort();
}

describe("resolveResearchArchiveDir", () => {
  it("有项目时落项目下的 research/", () => {
    const projectPath = join(root, "my-project");
    expect(resolveResearchArchiveDir(projectPath)).toBe(join(projectPath, "research"));
  });

  // 兜底沿用既有的小写 ~/Documents/cortex（documentsCortexDir），不新造大写根目录，
  // 否则用户会在文稿里看到两个语义相同、只有大小写不同的 Cortex 目录。
  it("无项目时落 <documentsCortexDir>/research/", () => {
    expect(resolveResearchArchiveDir(null)).toBe(join(root, "cortex", "research"));
  });
});

describe("archiveResearchReport", () => {
  it("目录不存在时逐级建出，写入带来源抬头的 md，返回落盘路径", async () => {
    const projectPath = join(root, "proj", "nested");
    const written = await fsp
      .mkdir(projectPath, { recursive: true })
      .then(() =>
        archiveResearchReport({
          projectPath,
          sessionId: "sess-abcdef12-0000",
          objective: "调研 node:sqlite 是否可用于生产",
          markdown: "# 结论\n\n可用。",
        }),
      );

    expect(written).toBe(join(projectPath, "research", "调研 node sqlite 是否可用于生产.md"));
    const body = await fsp.readFile(written, "utf8");
    expect(body).toContain("来自 Cortex 深度研究：调研 node:sqlite 是否可用于生产");
    expect(body).toContain("sess-abcdef12-0000");
    expect(body).toContain("# 结论");
  });

  it("项目目录本身还不存在也照建（recursive）", async () => {
    const written = await archiveResearchReport({
      projectPath: join(root, "never-created"),
      sessionId: "s1",
      objective: "主题",
      markdown: "正文",
    });
    expect(written).toBe(join(root, "never-created", "research", "主题.md"));
  });

  // 归档绝不覆盖：同一目标连跑两次是常见操作，第二份报告直接盖掉第一份等于静默丢数据。
  it("同名文件已存在时递增到 (2) / (3)，不覆盖原文件", async () => {
    const projectPath = join(root, "proj");
    const input = { projectPath, sessionId: "s1", objective: "主题", markdown: "第一份" };
    const first = await archiveResearchReport(input);
    const second = await archiveResearchReport({ ...input, markdown: "第二份" });
    const third = await archiveResearchReport({ ...input, markdown: "第三份" });

    expect(first).toBe(join(projectPath, "research", "主题.md"));
    expect(second).toBe(join(projectPath, "research", "主题 (2).md"));
    expect(third).toBe(join(projectPath, "research", "主题 (3).md"));
    expect(await fsp.readFile(first, "utf8")).toContain("第一份");
    expect(await fsp.readFile(second, "utf8")).toContain("第二份");
  });

  // 递增不可能无限试下去：撞满之后退回带 sessionId 的必然唯一名，而不是抛错丢掉报告。
  it("递增撞满 50 次后回落 <名字>-<id8>.md", async () => {
    const projectPath = join(root, "proj");
    const dir = join(projectPath, "research");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, "主题.md"), "占位");
    for (let i = 2; i <= 50; i += 1) {
      await fsp.writeFile(join(dir, `主题 (${i}).md`), "占位");
    }

    const written = await archiveResearchReport({
      projectPath,
      sessionId: "abcdef1234567890",
      objective: "主题",
      markdown: "正文",
    });

    expect(written).toBe(join(dir, "主题-abcdef12.md"));
  });

  // 研究目标是用户自由输入的一句话，路径穿越必须在文件名清洗那一步就被吃掉；
  // 这里断言的是最终落点仍在归档目录内（纵深防御的可观测结果）。
  it("目标里带 ../ 也只落在归档目录内，不写到上级目录", async () => {
    const projectPath = join(root, "proj");
    const dir = join(projectPath, "research");
    const written = await archiveResearchReport({
      projectPath,
      sessionId: "s1",
      objective: "../../etc/passwd",
      markdown: "正文",
    });

    expect(written.startsWith(dir + sep)).toBe(true);
    expect(await listArchive(dir)).toEqual(["etc passwd.md"]);
  });

  // 包含性校验以 realpath 后的归档目录为基准：research/（或其父级）被换成软链时，
  // 纯字符串前缀比较会被绕过。但返回值与写入仍用调用方给的原始路径——realpath 会把
  // macOS 的 /var 规范化成 /private/var，返回规范化路径会让调用方看到与配置不一致的落点。
  it("归档目录是软链时仍写进去，且返回调用方给的原始路径（不做 realpath 规范化）", async () => {
    const realHome = join(root, "real-home");
    const projectPath = join(root, "proj");
    await fsp.mkdir(join(realHome, "research"), { recursive: true });
    await fsp.mkdir(projectPath, { recursive: true });
    // proj/research → real-home/research
    await fsp.symlink(join(realHome, "research"), join(projectPath, "research"), "dir");

    const written = await archiveResearchReport({
      projectPath,
      sessionId: "s1",
      objective: "主题",
      markdown: "正文",
    });

    // 返回的是软链路径本身，不是解析后的真实路径。
    expect(written).toBe(join(projectPath, "research", "主题.md"));
    // 内容确实落在软链目标里。
    expect(await fsp.readFile(join(realHome, "research", "主题.md"), "utf8")).toContain("正文");
  });

  it("目标清洗后为空时用 research-<id8> 兜底", async () => {
    const projectPath = join(root, "proj");
    const written = await archiveResearchReport({
      projectPath,
      sessionId: "abcdef1234567890",
      objective: "///",
      markdown: "正文",
    });
    expect(written).toBe(join(projectPath, "research", "research-abcdef12.md"));
  });

  it("无项目时写进 Documents 兜底目录", async () => {
    const written = await archiveResearchReport({
      projectPath: null,
      sessionId: "s1",
      objective: "主题",
      markdown: "正文",
    });
    expect(written).toBe(join(root, "cortex", "research", "主题.md"));
  });
});
