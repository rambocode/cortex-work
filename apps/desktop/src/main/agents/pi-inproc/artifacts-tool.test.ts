// artifacts 工具单测。核心锁两条契约:① 错误一律 throw（0.82.1 丢弃 isError 字段）且文案可纠偏;
// ② 成功变更的 details.artifact 带**应用变更后的全量 content**（mapPiEvent 靠它派生 artifact 事件）。

import { describe, expect, it } from "vitest";

import { ARTIFACT_MAX_CONTENT_BYTES, createArtifactsTool, type ArtifactDetails } from "./artifacts-tool";

// execute 的第 3-5 参（signal/onUpdate/ctx）本工具不使用,传 undefined 即可。
async function run(tool: ReturnType<typeof createArtifactsTool>, params: Record<string, unknown>) {
  return (await tool.execute("tc-1", params as never, undefined as never, undefined as never, undefined as never)) as {
    content: [{ type: "text"; text: string }];
    details: ArtifactDetails | undefined;
  };
}

describe("artifacts 工具", () => {
  it("create 返回全量快照 details,重复 create 报已存在", async () => {
    const tool = createArtifactsTool();
    const res = await run(tool, { command: "create", filename: "a.md", content: "# hi" });
    expect(res.details?.artifact).toEqual({ action: "create", filename: "a.md", content: "# hi" });
    await expect(run(tool, { command: "create", filename: "a.md", content: "x" })).rejects.toThrow(
      "already exists",
    );
  });

  it("update 命中后 details 带替换后的全量内容;未命中回全文帮模型重新定位", async () => {
    const tool = createArtifactsTool();
    await run(tool, { command: "create", filename: "a.html", content: "<h1>old</h1><p>keep</p>" });
    const res = await run(tool, { command: "update", filename: "a.html", old_str: "old", new_str: "new" });
    // 契约:全量内容,而非增量补丁（渲染层不做字符串替换）。
    expect(res.details?.artifact.content).toBe("<h1>new</h1><p>keep</p>");
    await expect(
      run(tool, { command: "update", filename: "a.html", old_str: "不存在", new_str: "x" }),
    ).rejects.toThrow("<h1>new</h1><p>keep</p>"); // 错误信息附带当前全文
  });

  it("rewrite 归一为 update 动作;get 返回内容且无 details;delete 后文件不可再取", async () => {
    const tool = createArtifactsTool();
    await run(tool, { command: "create", filename: "a.md", content: "v1" });
    const rw = await run(tool, { command: "rewrite", filename: "a.md", content: "v2" });
    expect(rw.details?.artifact).toEqual({ action: "update", filename: "a.md", content: "v2" });
    const got = await run(tool, { command: "get", filename: "a.md" });
    expect(got.content[0].text).toBe("v2");
    expect(got.details).toBeUndefined();
    const del = await run(tool, { command: "delete", filename: "a.md" });
    expect(del.details?.artifact).toEqual({ action: "delete", filename: "a.md" });
    await expect(run(tool, { command: "get", filename: "a.md" })).rejects.toThrow("No files have been created yet");
  });

  it("不存在的文件报错时列出现有文件名,帮模型改对 filename", async () => {
    const tool = createArtifactsTool();
    await run(tool, { command: "create", filename: "list.md", content: "x" });
    await expect(run(tool, { command: "get", filename: "nope.md" })).rejects.toThrow("Available files: list.md");
  });

  it("filename 闸门:路径分隔 / .. / 隐藏文件 / 空名一律拒绝", async () => {
    const tool = createArtifactsTool();
    for (const bad of ["../x.md", "a/b.md", ".hidden", "", "a\\b.md"]) {
      await expect(run(tool, { command: "create", filename: bad, content: "x" })).rejects.toThrow();
    }
  });

  it("content 超 1MB 拒绝(create 与 update 后的结果都受限)", async () => {
    const tool = createArtifactsTool();
    const big = "x".repeat(ARTIFACT_MAX_CONTENT_BYTES + 1);
    await expect(run(tool, { command: "create", filename: "big.txt", content: big })).rejects.toThrow("1MB");
    await run(tool, { command: "create", filename: "s.txt", content: "seed" });
    await expect(
      run(tool, { command: "update", filename: "s.txt", old_str: "seed", new_str: big }),
    ).rejects.toThrow("1MB");
  });

  it("未知 command 与缺参报可读错误", async () => {
    const tool = createArtifactsTool();
    await expect(run(tool, { command: "logs", filename: "a.md" })).rejects.toThrow("Unknown command");
    await expect(run(tool, { command: "create", filename: "a.md" })).rejects.toThrow("requires filename and content");
  });
});
