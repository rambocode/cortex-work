import { describe, expect, it } from "vitest";
import { extractCwd } from "./agent-projects-parse";

describe("extractCwd", () => {
  it("从 jsonl 文件头抓取第一个 cwd 字段", () => {
    const head = '{"type":"session_meta","payload":{"cwd":"/Users/mike/source/ai/cortex-work","id":"x"}}\n{"cwd":"/other"}';
    expect(extractCwd(head)).toBe("/Users/mike/source/ai/cortex-work");
  });

  it("容忍冒号前后空白", () => {
    expect(extractCwd('{ "cwd" : "/tmp/proj" }')).toBe("/tmp/proj");
  });

  it("解码 JSON 转义（反斜杠路径 / unicode）", () => {
    expect(extractCwd('{"cwd":"C:\\\\Users\\\\mike\\\\proj"}')).toBe("C:\\Users\\mike\\proj");
    expect(extractCwd('{"cwd":"/tmp/\\u4e2d\\u6587"}')).toBe("/tmp/中文");
  });

  it("缺少 cwd 字段返回 null", () => {
    expect(extractCwd('{"type":"user","text":"hello"}')).toBeNull();
    expect(extractCwd("")).toBeNull();
  });

  it("被截断的值（无闭合引号）不误抓", () => {
    expect(extractCwd('{"cwd":"/Users/mike/very/long/pa')).toBeNull();
  });
});
