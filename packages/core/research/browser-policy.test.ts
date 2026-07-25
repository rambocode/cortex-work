// Research Browser 命令行与 action policy 的表驱动单测（spec §19.2.3 中唯一可自动化的部分）。
//
// 这些断言是安全断言而不是风格断言：一旦有人「顺手」往参数里加了 --profile / --state，
// 或者把 action policy 从白名单改成黑名单，这里必须立刻变红。
import { describe, expect, it } from "vitest";
import {
  buildAgentBrowserArgs,
  buildReadOnlyActionPolicy,
  buildResearchNamespace,
  DEFAULT_BROWSER_MAX_OUTPUT,
  FORBIDDEN_AGENT_BROWSER_FLAGS,
  PROBE_DENIED_ACTION,
  PROBE_DENIED_ACTION_NAME,
  READ_ONLY_ALLOWED_ACTIONS,
} from "./browser-policy";

describe("buildAgentBrowserArgs", () => {
  it("产出逐字确定的参数序列", () => {
    const args = buildAgentBrowserArgs({
      sessionToken: "tok_123",
      namespace: "cortex-research-abc",
      allowedDomains: ["example.com", "docs.example.org"],
      policyPath: "/var/research/browser-policy/p-tok_123.json",
    });

    expect(args).toEqual([
      "--session",
      "tok_123",
      "--namespace",
      "cortex-research-abc",
      "--restore-save",
      "never",
      "--allowed-domains",
      "example.com,docs.example.org",
      "--content-boundaries",
      "--max-output",
      "200000",
      "--action-policy",
      "/var/research/browser-policy/p-tok_123.json",
      "--json",
    ]);
  });

  it("maxOutput 可覆盖默认值", () => {
    const args = buildAgentBrowserArgs({
      sessionToken: "t",
      namespace: "n",
      allowedDomains: ["a.com"],
      policyPath: "/p.json",
      maxOutput: 4096,
    });
    expect(args[args.indexOf("--max-output") + 1]).toBe("4096");
    expect(DEFAULT_BROWSER_MAX_OUTPUT).toBe(200_000);
  });

  it.each(FORBIDDEN_AGENT_BROWSER_FLAGS)("参数序列绝不包含 %s", (flag) => {
    const args = buildAgentBrowserArgs({
      sessionToken: "t",
      namespace: "n",
      allowedDomains: ["a.com"],
      policyPath: "/p.json",
    });
    expect(args).not.toContain(flag);
    // 连以 "--profile=x" 形式出现也不允许。
    expect(args.some((arg) => arg.startsWith(`${flag}=`))).toBe(false);
  });

  it("空的 allowedDomains 直接抛错（fail closed）", () => {
    expect(() =>
      buildAgentBrowserArgs({
        sessionToken: "t",
        namespace: "n",
        allowedDomains: [],
        policyPath: "/p.json",
      }),
    ).toThrow();
  });

  it.each([["a.com,evil.com"], ["a.com b.com"], [""], ["--allow-file-access"]])(
    "非法域名条目 %j 直接抛错",
    (domain) => {
      expect(() =>
        buildAgentBrowserArgs({
          sessionToken: "t",
          namespace: "n",
          allowedDomains: [domain],
          policyPath: "/p.json",
        }),
      ).toThrow();
    },
  );

  it("sessionToken / namespace / policyPath 为空时抛错", () => {
    const base = {
      sessionToken: "t",
      namespace: "n",
      allowedDomains: ["a.com"],
      policyPath: "/p.json",
    };
    expect(() => buildAgentBrowserArgs({ ...base, sessionToken: "" })).toThrow();
    expect(() => buildAgentBrowserArgs({ ...base, namespace: "" })).toThrow();
    expect(() => buildAgentBrowserArgs({ ...base, policyPath: "" })).toThrow();
  });
});

describe("buildReadOnlyActionPolicy", () => {
  it("使用 default: deny 的白名单模式", () => {
    expect(buildReadOnlyActionPolicy().default).toBe("deny");
  });

  it("allow 列表即只读白名单", () => {
    expect(buildReadOnlyActionPolicy().allow).toEqual([...READ_ONLY_ALLOWED_ACTIONS]);
  });

  it.each(["read", "open", "get", "snapshot", "close", "session", "wait"])(
    "只读动作 %s 在白名单内",
    (action) => {
      expect(buildReadOnlyActionPolicy().allow).toContain(action);
    },
  );

  it.each(["evaluate", "upload", "download", "clipboard", "screenshot"])(
    "危险动作 %s 不在白名单内",
    (action) => {
      expect(buildReadOnlyActionPolicy().allow).not.toContain(action);
    },
  );

  it("探针动作用子命令名 eval、规范名 evaluate", () => {
    // U0 S4：动作名是规范名不是子命令名，白名单写 "eval" 会静默放行。
    expect(PROBE_DENIED_ACTION).toBe("eval");
    expect(PROBE_DENIED_ACTION_NAME).toBe("evaluate");
    expect(buildReadOnlyActionPolicy().allow).not.toContain(PROBE_DENIED_ACTION);
    expect(buildReadOnlyActionPolicy().allow).not.toContain(PROBE_DENIED_ACTION_NAME);
  });

  it("每次调用返回可安全改写的新对象", () => {
    const first = buildReadOnlyActionPolicy();
    first.allow.push("evaluate");
    expect(buildReadOnlyActionPolicy().allow).not.toContain("evaluate");
  });
});

describe("buildResearchNamespace", () => {
  it.each([
    ["sess_01H", "cortex-research-sess_01H"],
    ["../../etc", "cortex-research-etc"],
    ["a;rm -rf /", "cortex-research-arm-rf"],
    ["a/b\\c", "cortex-research-abc"],
    ["$(whoami)", "cortex-research-whoami"],
    ["with space", "cortex-research-withspace"],
  ])("清洗 %j", (sessionId, expected) => {
    expect(buildResearchNamespace(sessionId)).toBe(expected);
  });

  it("清洗后为空时回退到固定占位，不产生裸前缀", () => {
    expect(buildResearchNamespace("///")).toBe("cortex-research-unknown");
    expect(buildResearchNamespace("")).toBe("cortex-research-unknown");
  });

  it("过长的 sessionId 被截断", () => {
    const namespace = buildResearchNamespace("x".repeat(500));
    expect(namespace.length).toBeLessThanOrEqual(80);
    expect(namespace.startsWith("cortex-research-")).toBe(true);
  });

  it.each(["../../etc", "a;rm -rf /", "$(whoami)", "a b|c&d"])(
    "%j 清洗后只含 [a-zA-Z0-9_-]",
    (sessionId) => {
      expect(buildResearchNamespace(sessionId)).toMatch(/^[a-zA-Z0-9_-]+$/);
    },
  );
});

/// 回归：action policy 的 allow 列表必须用**规范动作名**，不是子命令名。
///
/// 真实踩过：列表里只有 `"open"`，而 agent-browser 把 `open` 子命令归一成 `navigate`，
/// 于是导航永远被 deny。后果不是「报错」而是**整条 Browser 兜底静默失效**——
/// 适配器退而用 `read <url>`，那条路走的是 agent-browser 自带的 HTTP 客户端、
/// 根本不启动 Chrome，对 JS 渲染页拿到 0 字，对 403 站点再吃一次 403。
/// 也就是说：Browser 兜底对它存在的全部三个触发场景（403 / 429 / 空正文）都没用。
/// 这与 PROBE_DENIED_ACTION（`eval`）与 PROBE_DENIED_ACTION_NAME（`evaluate`）是同一个坑。
describe("action policy 的动作名", () => {
  it("allow 列表含规范名 navigate，否则导航被 deny、Chrome 永不启动", () => {
    expect(buildReadOnlyActionPolicy().allow).toContain("navigate");
  });

  it("同时保留子命令名 open，兼容按子命令名判定的 agent-browser 版本", () => {
    expect(buildReadOnlyActionPolicy().allow).toContain("open");
  });
});
