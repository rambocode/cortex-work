import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { chatCompletionsUrl, dingtalkSignedUrl } from "./push-sign";

describe("dingtalkSignedUrl", () => {
  it("追加 timestamp 与 URL 编码后的 HMAC-SHA256 签名", () => {
    const ts = 1781180000000;
    const secret = "SECtest";
    const url = dingtalkSignedUrl("https://oapi.dingtalk.com/robot/send?access_token=abc", secret, ts);
    const expected = encodeURIComponent(
      createHmac("sha256", secret).update(`${ts}\n${secret}`).digest("base64"),
    );
    expect(url).toBe(
      `https://oapi.dingtalk.com/robot/send?access_token=abc&timestamp=${ts}&sign=${expected}`,
    );
  });

  it("无查询串时用 ? 连接", () => {
    expect(dingtalkSignedUrl("https://oapi.dingtalk.com/robot/send", "s", 1)).toContain("/send?timestamp=1&");
  });
});

describe("chatCompletionsUrl", () => {
  it("无版本段时补 /v1", () => {
    expect(chatCompletionsUrl("http://localhost:11434")).toBe("http://localhost:11434/v1/chat/completions");
    expect(chatCompletionsUrl("http://localhost:11434/")).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("已带版本段时不重复", () => {
    expect(chatCompletionsUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1/chat/completions");
    expect(chatCompletionsUrl("http://127.0.0.1:8000/v2/")).toBe("http://127.0.0.1:8000/v2/chat/completions");
  });
});
