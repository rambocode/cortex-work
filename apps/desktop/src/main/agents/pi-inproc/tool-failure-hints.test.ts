// bash 失败纠偏提示单测:识别规则的命中 / 不命中边界,以及 tool_result 钩子只对 bash 生效且只追加不覆盖。
import { describe, expect, it } from "vitest";

import { TOOL_FAILURE_HINT_PREFIX, createToolFailureHintExtension, detectToolFailure } from "./tool-failure-hints";

describe("detectToolFailure", () => {
  it("Python ModuleNotFoundError:取顶层模块名,并给出标准库替代", () => {
    const out = [
      "Traceback (most recent call last):",
      '  File "<stdin>", line 1, in <module>',
      "ModuleNotFoundError: No module named 'bs4'",
    ].join("\n");
    const hint = detectToolFailure(out);
    expect(hint?.kind).toBe("python-module");
    expect(hint?.subject).toBe("bs4");
    expect(hint?.text).toContain("html.parser");
    expect(hint?.text).toContain("without asking the user first");
  });

  it("子模块缺失(yaml.loader)归到顶层名;无映射的模块给通用替代语", () => {
    expect(detectToolFailure("ModuleNotFoundError: No module named 'foo.bar'")).toMatchObject({
      kind: "python-module",
      subject: "foo",
    });
    expect(detectToolFailure("ModuleNotFoundError: No module named 'foo'")?.text).toContain("standard-library alternative");
  });

  it("shell command not found:zsh / bash / sh 三种文案都能识别", () => {
    expect(detectToolFailure("zsh: command not found: pandoc")).toMatchObject({ kind: "command-not-found", subject: "pandoc" });
    expect(detectToolFailure("bash: ffmpeg: command not found")).toMatchObject({ kind: "command-not-found", subject: "ffmpeg" });
    expect(detectToolFailure("sh: 1: jq: not found")).toMatchObject({ kind: "command-not-found", subject: "jq" });
  });

  it("Node Cannot find module:裸包名(含 scope)命中,相对/绝对路径不命中", () => {
    expect(detectToolFailure("Error: Cannot find module 'cheerio'")).toMatchObject({ kind: "node-module", subject: "cheerio" });
    expect(detectToolFailure("Error: Cannot find module '@scope/pkg'")).toMatchObject({ kind: "node-module", subject: "@scope/pkg" });
    expect(detectToolFailure("Error: Cannot find module './lib/x'")).toBeNull();
    expect(detectToolFailure("Error: Cannot find module '/abs/x.js'")).toBeNull();
  });

  it("普通输出与空输出不命中", () => {
    expect(detectToolFailure("")).toBeNull();
    expect(detectToolFailure("total 3\n-rw-r--r-- a.txt")).toBeNull();
    expect(detectToolFailure("ls: no such file or directory: x")).toBeNull();
  });
});

describe("createToolFailureHintExtension", () => {
  type Handler = (event: {
    type: "tool_result";
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    content: Array<{ type: "text"; text: string }>;
    isError: boolean;
  }) => { content?: unknown[] } | void;

  /** 假 ExtensionAPI:只收集 tool_result 处理器。 */
  function mount(): Handler {
    const handlers: Handler[] = [];
    const api = { on: (event: string, handler: unknown) => event === "tool_result" && handlers.push(handler as Handler) };
    (createToolFailureHintExtension() as { factory: (pi: unknown) => void }).factory(api);
    expect(handlers).toHaveLength(1);
    return handlers[0]!;
  }

  const bashEvent = (text: string, toolName = "bash") => ({
    type: "tool_result" as const,
    toolCallId: "c1",
    toolName,
    input: { command: "python3 -c 'import bs4'" },
    content: [{ type: "text" as const, text }],
    isError: true,
  });

  it("bash 结果命中时追加提示块,原有 content 保留在前", () => {
    const result = mount()(bashEvent("ModuleNotFoundError: No module named 'bs4'"));
    expect(result?.content).toHaveLength(2);
    expect(result?.content?.[0]).toEqual({ type: "text", text: "ModuleNotFoundError: No module named 'bs4'" });
    expect((result?.content?.[1] as { text: string }).text.startsWith(`\n${TOOL_FAILURE_HINT_PREFIX} `)).toBe(true);
  });

  it("非 bash 工具(如 read 到的文件内容)不处理", () => {
    expect(mount()(bashEvent("zsh: command not found: pandoc", "read"))).toBeUndefined();
  });

  it("未命中时返回 undefined,不改写结果", () => {
    expect(mount()(bashEvent("hello"))).toBeUndefined();
  });
});
