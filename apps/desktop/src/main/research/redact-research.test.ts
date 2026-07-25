// CRE 日志脱敏的红线测试（spec §19.3.1、§19.3.2）：查询原文、正文、凭据三者都不得落盘。
import { describe, expect, it } from "vitest";
import { hashQueryText, redactResearchLog, redactUrl, scrubSecret } from "./redact-research";

const QUERY = "老板的离职传闻 2026 内部消息";
const BODY = "这是抓取到的网页正文，绝对不能进日志。";
const TOKEN = "cortex-pat-1234567890";

describe("redactResearchLog", () => {
  it("查询原文、正文、token 三者都不出现在输出里", () => {
    const output = JSON.stringify(
      redactResearchLog({
        query: QUERY,
        objective: QUERY,
        searchServer: { token: TOKEN, apiKey: TOKEN, baseUrl: "https://s.example.com/api?k=" + TOKEN },
        headers: { authorization: `Bearer ${TOKEN}` },
        documents: [
          { url: `https://e.com/a?secret=${QUERY}#frag`, text: BODY, markdown: BODY, title: "标题可以保留" },
        ],
      }),
    );

    expect(output).not.toContain(QUERY);
    expect(output).not.toContain(BODY);
    expect(output).not.toContain(TOKEN);
    // 非敏感元数据仍然保留，否则日志失去排查价值。
    expect(output).toContain("标题可以保留");
  });

  it("查询只记 hash + 长度", () => {
    const redacted = redactResearchLog({ query: QUERY }) as { query: { hash: string; length: number } };
    expect(redacted.query.hash).toBe(hashQueryText(QUERY));
    expect(redacted.query.length).toBe(QUERY.length);
  });

  it("URL 去掉 query string 与 fragment，只留 origin + path", () => {
    const redacted = redactResearchLog({ url: "https://e.com/a/b?q=x&t=1#top" }) as { url: string };
    expect(redacted.url).toBe("https://e.com/a/b");
  });

  it("正文字段替换为长度占位，不保留任何片段", () => {
    const redacted = redactResearchLog({ text: BODY }) as { text: string };
    expect(redacted.text).toBe(`[body omitted:${BODY.length}]`);
  });

  it("数组、嵌套对象与循环引用都能处理", () => {
    const cyclic: Record<string, unknown> = { url: "https://e.com/x?y=1" };
    cyclic["self"] = cyclic;
    const output = JSON.stringify(redactResearchLog([cyclic, { snippet: BODY }]));
    expect(output).toContain("https://e.com/x");
    expect(output).not.toContain("y=1");
    expect(output).not.toContain(BODY);
  });

  it("裸字符串也过一遍通用脱敏（Bearer token 被抹掉）", () => {
    expect(redactResearchLog(`Authorization: Bearer ${TOKEN}`)).not.toContain(TOKEN);
  });
});

describe("redactUrl", () => {
  it("畸形 URL 原样降级为 [invalid-url]，不抛错", () => {
    expect(redactUrl("not a url")).toBe("[invalid-url]");
  });
});

describe("scrubSecret", () => {
  it("抹掉整串出现的凭据", () => {
    expect(scrubSecret(`失败：Bearer ${TOKEN} 无效`, TOKEN)).toBe("失败：Bearer *** 无效");
  });

  it("同一段文本里多次出现都要抹掉", () => {
    expect(scrubSecret(`${TOKEN} / ${TOKEN}`, TOKEN)).toBe("*** / ***");
  });

  it("空 secret 时原样返回（不能把整段文本替换成 ***）", () => {
    expect(scrubSecret("原文", "")).toBe("原文");
  });
});
