// 自定义 Provider 的渲染端校验规则单测。
// 这两道门是安全边界：明文密钥内嵌会绕过 safeStorage 直接落盘；未定义的 Secret 引用
// 会在运行期变成空 Header（表现为 401，而不是一句「你少配了个 Secret」）。

import { describe, expect, it } from "vitest";
import {
  extractSecretRefs,
  findInlineSecrets,
  slugifyProviderId,
  undefinedSecretRefs,
} from "./customProviderRules";

describe("Secret 引用扫描", () => {
  it("提取 ${secret:NAME} 引用，去重保序", () => {
    const json = `{"headers":{"a":"\${secret:TOKEN}","b":"\${secret:ORG}","c":"\${secret:TOKEN}"}}`;
    expect(extractSecretRefs(json)).toEqual(["TOKEN", "ORG"]);
  });

  it("找出被引用但未定义的 Secret", () => {
    const json = `{"headers":{"a":"\${secret:TOKEN}","b":"\${secret:ORG}"}}`;
    expect(undefinedSecretRefs(json, ["TOKEN"])).toEqual(["ORG"]);
    expect(undefinedSecretRefs(json, ["TOKEN", "ORG"])).toEqual([]);
  });
});

describe("明文密钥嗅探", () => {
  it("敏感字段写了明文 → 报错并给出行号", () => {
    const json = ['{', '  "name": "gw",', '  "apiKey": "sk-live-abcdef"', '}'].join("\n");
    const issues = findInlineSecrets(json);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.line).toBe(3);
    expect(issues[0]!.message).toBe("apiKey");
  });

  it("改成 ${secret:NAME} 引用后放行", () => {
    const json = ['{', '  "apiKey": "${secret:TOKEN}"', '}'].join("\n");
    expect(findInlineSecrets(json)).toHaveLength(0);
  });

  it("Authorization / token / password 等同样命中", () => {
    const json = [
      '{',
      '  "headers": {',
      '    "Authorization": "Bearer xyz",',
      '    "x-token": "t1",',
      '    "password": "p"',
      '  }',
      '}',
    ].join("\n");
    expect(findInlineSecrets(json).map((i) => i.message)).toEqual(["Authorization", "x-token", "password"]);
  });

  it("非敏感字段与空值不误报", () => {
    const json = ['{', '  "name": "gw",', '  "baseUrl": "https://x/v1",', '  "apiKey": ""', '}'].join("\n");
    expect(findInlineSecrets(json)).toHaveLength(0);
  });
});

describe("provider id slug", () => {
  it("规范化为 pi 可用的标识", () => {
    expect(slugifyProviderId("  My Gateway! ")).toBe("my-gateway");
    expect(slugifyProviderId("---")).toBe("custom-provider");
    expect(slugifyProviderId("")).toBe("custom-provider");
  });

  // 与主进程 agents/pi-providers.ts 的 safeId 的镜像用例（同输入同输出）：
  // 撞名判定 / 注册键 / 查找归一全依赖两侧算法一致，主进程侧在 custom-providers.test.ts 有对应用例。
  it("与主进程 safeId 同口径（镜像用例）", () => {
    expect(slugifyProviderId("DeepSeek")).toBe("deepseek");
    expect(slugifyProviderId("My.Ollama")).toBe("my-ollama");
    expect(slugifyProviderId("Kimi Coding")).toBe("kimi-coding");
  });
});

describe("findInlineSecrets：compat 子树整棵跳过（线上死锁回归）", () => {
  it("compat 里的 maxTokensField 不再被判成明文密钥", () => {
    // `maxTokensField` 归一后含 "token"，曾被判成明文密钥。它是 pi 的协议行为开关，
    // **根本不能写成 ${secret:} 引用** —— 误报会把用户彻底卡死：网关向导生成的合法配置
    // 粘进 JSON 编辑器后连报数行，怎么改都保存不了。
    const json = JSON.stringify(
      {
        name: "网关",
        baseUrl: "https://gw/v1",
        models: [
          {
            id: "m",
            compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens", supportsToolSearch: true },
          },
        ],
      },
      null,
      2,
    );
    expect(findInlineSecrets(json)).toEqual([]);
  });

  it("compat 之外的明文密钥照常被抓（跳过 compat 不等于整体放松）", () => {
    const json = JSON.stringify(
      { headers: { Authorization: "Bearer sk-plain" }, models: [{ id: "m", compat: { maxTokensField: "max_tokens" } }] },
      null,
      2,
    );
    const issues = findInlineSecrets(json);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toBe("Authorization");
  });

  it("compat 块结束后恢复检测（花括号计数不能漏出）", () => {
    const json = [
      "{",
      '  "models": [',
      '    { "id": "m", "compat": { "maxTokensField": "max_tokens" } }',
      "  ],",
      '  "apiKey": "sk-leaked"',
      "}",
    ].join("\n");
    const issues = findInlineSecrets(json);
    expect(issues.map((i) => i.message)).toEqual(["apiKey"]);
  });
});
