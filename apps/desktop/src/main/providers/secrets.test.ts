import { describe, expect, it } from "vitest";

import {
  collectSecretRefs,
  findUndefinedSecretRefs,
  isAllowedSensitiveValue,
  isSensitiveFieldName,
  redactAuthText,
  resolveSecretRefs,
  safeErrorMessage,
} from "./secrets";

describe("collectSecretRefs", () => {
  it("提取并去重", () => {
    const text = '{"apiKey":"${secret:A}","headers":{"X":"${secret:B}","Y":"${secret:A}"}}';
    expect(collectSecretRefs(text)).toEqual(["A", "B"]);
  });

  it("没有引用时返回空数组", () => {
    expect(collectSecretRefs('{"a":1}')).toEqual([]);
  });

  // 全局正则带 lastIndex 状态，连续调用若不重置会漏匹配——这是最容易踩的坑。
  it("连续调用结果一致（lastIndex 已重置）", () => {
    const text = "${secret:A} ${secret:B}";
    expect(collectSecretRefs(text)).toEqual(collectSecretRefs(text));
  });
});

describe("resolveSecretRefs", () => {
  it("替换已定义的引用", () => {
    const { text, missing } = resolveSecretRefs("Bearer ${secret:TOKEN}", { TOKEN: "t-123" });
    expect(text).toBe("Bearer t-123");
    expect(missing).toEqual([]);
  });

  // 静默替换成空串会拼出「看起来配好了、实际无鉴权」的请求，必须原样保留并报缺失。
  it("缺失的引用保持原样并被列出", () => {
    const { text, missing } = resolveSecretRefs("${secret:A}-${secret:B}", { A: "1" });
    expect(text).toBe("1-${secret:B}");
    expect(missing).toEqual(["B"]);
  });
});

describe("findUndefinedSecretRefs", () => {
  it("只报未定义的", () => {
    expect(findUndefinedSecretRefs("${secret:A}${secret:B}", ["A"])).toEqual(["B"]);
  });
});

describe("isSensitiveFieldName / isAllowedSensitiveValue", () => {
  it("识别常见敏感字段名", () => {
    for (const key of ["apiKey", "api_key", "Authorization", "accessToken", "clientSecret", "password"]) {
      expect(isSensitiveFieldName(key)).toBe(true);
    }
    expect(isSensitiveFieldName("baseUrl")).toBe(false);
  });

  it("敏感值只接受 secret 引用 / 环境变量插值 / 命令", () => {
    expect(isAllowedSensitiveValue("${secret:MY_KEY}")).toBe(true);
    expect(isAllowedSensitiveValue("$MY_KEY")).toBe(true);
    expect(isAllowedSensitiveValue("${MY_KEY}")).toBe(true);
    expect(isAllowedSensitiveValue("!op read x")).toBe(true);
    expect(isAllowedSensitiveValue("sk-live-abcdef")).toBe(false);
    expect(isAllowedSensitiveValue("Bearer sk-live-abcdef")).toBe(false);
  });
});

describe("redactAuthText / safeErrorMessage（禁泄红线）", () => {
  it("抹掉 OAuth 授权码与 token", () => {
    const text = "callback failed: https://sso.example.com/cb?code=AUTHCODE123&state=xyz";
    const out = redactAuthText(text);
    expect(out).not.toContain("AUTHCODE123");
    expect(out).toContain("code=***");
  });

  it("抹掉 access/refresh token 与 client_secret", () => {
    const out = redactAuthText('{"access_token":"AT-1","refresh_token":"RT-2","client_secret":"CS-3"}');
    expect(out).not.toContain("AT-1");
    expect(out).not.toContain("RT-2");
    expect(out).not.toContain("CS-3");
  });

  it("抹掉 Authorization 头与 api key", () => {
    const out = redactAuthText('headers: {"authorization":"Bearer sk-live-XYZ","apiKey":"sk-live-XYZ"}');
    expect(out).not.toContain("sk-live-XYZ");
  });

  it("超长文本被截断", () => {
    expect(redactAuthText("x".repeat(5000)).length).toBeLessThan(500);
  });

  // 错误对象整体透传是最常见的泄密路径：provider SDK 常把请求头/响应体挂在 cause 或自定义字段上。
  it("safeErrorMessage 只取脱敏后的 message，丢弃其它字段", () => {
    const err = Object.assign(new Error("request failed: apiKey=sk-live-SECRET"), {
      requestHeaders: { authorization: "Bearer sk-live-SECRET" },
      responseBody: '{"access_token":"sk-live-SECRET"}',
    });
    const out = safeErrorMessage(err);
    expect(out).not.toContain("sk-live-SECRET");
    expect(out).toContain("request failed");
    expect(JSON.stringify(out)).not.toContain("responseBody");
  });

  it("非 Error 与空 message 回落默认文案", () => {
    expect(safeErrorMessage(undefined, "默认")).toBe("默认");
    expect(safeErrorMessage(new Error("   "), "默认")).toBe("默认");
  });
});
