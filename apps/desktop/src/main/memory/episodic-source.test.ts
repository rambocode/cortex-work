import { promises as fsp } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readEpisodicInputs } from "./episodic-source";

describe("readEpisodicInputs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), "cortex-chats-"));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const deps = () => ({
    chatsDir: () => dir,
    getSessionTitles: async () => new Map<string, string>([["s1", "会话一"]]),
  });

  it("读取会话正文(v1 裸数组)并附上标题", async () => {
    await fsp.writeFile(join(dir, "s1.json"), JSON.stringify([{ kind: "text", who: "me", text: "你好" }]), "utf8");
    const inputs = await readEpisodicInputs(deps());
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.sessionId).toBe("s1");
    expect(inputs[0]!.title).toBe("会话一");
  });

  // 工作过程归档与会话正文同住 chats/ 目录，且顶层也是数组 —— 不显式排除就会被当成一段对话
  // 采样进「做梦」记忆，sessionId 还会带上 ".process" 后缀。
  it("跳过工作过程归档 <id>.process.json，不把它当会话采样", async () => {
    await fsp.writeFile(join(dir, "s1.json"), JSON.stringify([{ kind: "text", who: "me", text: "你好" }]), "utf8");
    await fsp.writeFile(
      join(dir, "s1.process.json"),
      JSON.stringify([{ runId: "run-1", startedAt: 0, endedAt: 1, messages: [{ kind: "agentLog" }], invocations: [] }]),
      "utf8",
    );
    const inputs = await readEpisodicInputs(deps());
    expect(inputs.map((x) => x.sessionId)).toEqual(["s1"]);
  });
});
