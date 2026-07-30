import { describe, expect, it } from "vitest";
import { langForName, wordWrapForName } from "./monacoLang";

describe("langForName", () => {
  it("常见扩展名映射", () => {
    expect(langForName("a.ts")).toBe("typescript");
    expect(langForName("a.tsx")).toBe("typescript");
    expect(langForName("main.go")).toBe("go");
    expect(langForName("README.md")).toBe("markdown");
    expect(langForName("style.css")).toBe("css");
    expect(langForName("conf.yaml")).toBe("yaml");
  });

  it("全名特例与大小写", () => {
    expect(langForName("Dockerfile")).toBe("dockerfile");
    expect(langForName("a.TS")).toBe("typescript");
  });

  it("未知扩展名回退 plaintext", () => {
    expect(langForName("a.zzz")).toBe("plaintext");
    expect(langForName("noext")).toBe("plaintext");
  });
});

describe("wordWrapForName", () => {
  it("散文类软换行,代码不换行", () => {
    expect(wordWrapForName("a.md")).toBe(true);
    expect(wordWrapForName("a.log")).toBe(true);
    expect(wordWrapForName("a.ts")).toBe(false);
  });
});
