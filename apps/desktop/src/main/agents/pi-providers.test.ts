// pi-providers 渲染单测：只测纯函数 renderPiExtension（不碰 electron/fs）。
import { describe, expect, it } from "vitest";
import { renderPiExtension, PI_KEY_ENV } from "./pi-providers";

describe("renderPiExtension", () => {
  const channel = {
    id: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-should-not-appear",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat" },
      { id: "deepseek-reasoner" },
    ],
  };

  it("注册 OpenAI 兼容 provider,含 baseUrl 与 registerProvider 调用", () => {
    const src = renderPiExtension(channel);
    expect(src).toContain("export default function (pi)");
    expect(src).toContain("pi.registerProvider(");
    expect(src).toContain('"openai-completions"');
    expect(src).toContain("https://api.deepseek.com/v1");
    expect(src).toContain('"deepseek"');
  });

  it("apiKey 用 $CORTEX_PI_KEY 占位,绝不写入明文 key", () => {
    const src = renderPiExtension(channel);
    expect(src).toContain(`$${PI_KEY_ENV}`);
    expect(src).not.toContain("sk-should-not-appear");
  });

  it("模型正确映射:id/name + 默认元数据", () => {
    const src = renderPiExtension(channel);
    expect(src).toContain('"deepseek-chat"');
    expect(src).toContain('"DeepSeek Chat"');
    // name 缺省回退到 id。
    expect(src).toContain('"deepseek-reasoner"');
    expect(src).toContain('"openai-completions"');
  });

  it("id 安全化:大写/空格/特殊字符 → 合法 slug provider 名", () => {
    const src = renderPiExtension({ id: "My Custom LLM!", baseUrl: "https://x/v1", models: [] });
    // 第一个 registerProvider 参数是安全化后的 id。
    expect(src).toContain('pi.registerProvider("my-custom-llm"');
  });

  it("插值值经 JSON 编码:含引号/反斜杠的 baseUrl 与 model id 不会破坏语法", () => {
    // 所有动态值都走 JSON.stringify,危险字符被转义,不会逃逸出字符串字面量。
    const src = renderPiExtension({
      id: "x",
      baseUrl: 'https://e/v1"; pwned()//',
      models: [{ id: 'm"]; hack()//' }],
    });
    // 原始未转义片段不应出现;转义后的形式才出现。
    expect(src).not.toContain('v1"; pwned');
    expect(src).toContain(JSON.stringify('https://e/v1"; pwned()//'));
    expect(src).toContain(JSON.stringify('m"]; hack()//'));
  });
});
