// skill frontmatter 解析单测（纯函数,不碰 electron/fs,沿用 main 纯函数测试惯例如 hotkey.test.ts）。
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter（SKILL.md 头解析）", () => {
  it("取 name/description/argument-hint 三键,去双引号", () => {
    const md = [
      "---",
      "name: ce-ideate",
      'description: "Generate and critically evaluate grounded ideas"',
      'argument-hint: "[focus] [output:md]"',
      "---",
      "",
      "# body",
    ].join("\n");
    expect(parseFrontmatter(md)).toEqual({
      name: "ce-ideate",
      description: "Generate and critically evaluate grounded ideas",
      argumentHint: "[focus] [output:md]",
    });
  });

  it("去单引号", () => {
    expect(parseFrontmatter("---\nname: 'ce-plan'\n---\n").name).toBe("ce-plan");
  });

  it("无 argument-hint 时该键 undefined", () => {
    const fm = parseFrontmatter("---\nname: ce-work\ndescription: do work\n---\n");
    expect(fm.name).toBe("ce-work");
    expect(fm.description).toBe("do work");
    expect(fm.argumentHint).toBeUndefined();
  });

  it("不以 --- 开头 → 空对象", () => {
    expect(parseFrontmatter("# no frontmatter\nname: x")).toEqual({});
  });

  it("无闭合 --- → 空对象", () => {
    expect(parseFrontmatter("---\nname: x\nno closing")).toEqual({});
  });

  it("只解析首个 frontmatter 块,正文里的 name: 不影响", () => {
    expect(parseFrontmatter("---\nname: ce-ideate\n---\nbody name: fake").name).toBe("ce-ideate");
  });

  it("忽略未知键（allowed-tools / model 等）", () => {
    const fm = parseFrontmatter("---\nname: x\nallowed-tools: Read, Write\nmodel: sonnet\n---\n");
    expect(fm.name).toBe("x");
    expect(Object.keys(fm)).toEqual(["name"]);
  });

  it("supported-agents:逗号分隔 → 字符串数组(U5)", () => {
    const fm = parseFrontmatter("---\nname: x\nsupported-agents: pi, claude\n---\n");
    expect(fm.supportedAgents).toEqual(["pi", "claude"]);
  });

  it("supported-agents:方括号写法 [pi, codex]", () => {
    const fm = parseFrontmatter("---\nname: x\nsupported-agents: [pi, codex]\n---\n");
    expect(fm.supportedAgents).toEqual(["pi", "codex"]);
  });

  it("无 supported-agents → undefined(=全 agent)", () => {
    expect(parseFrontmatter("---\nname: x\n---\n").supportedAgents).toBeUndefined();
  });
});
