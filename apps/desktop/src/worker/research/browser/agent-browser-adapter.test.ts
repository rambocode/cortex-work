// agent-browser 降级路径的适配器单测。
//
// 全部依赖（进程执行、写文件、删文件、随机 token）都是显式注入的手写替身，**不起真进程**。
// 最重要的两个用例是 fail-open 自检：
//   - 探针被拒 → 说明 action policy 真的生效 → 才允许继续抓取；
//   - 探针未被拒 → 策略失效 → 立刻 fail closed，绝不能发起 read。
import { describe, expect, it } from "vitest";
import { buildAgentBrowserArgs, buildReadOnlyActionPolicy } from "@cortex-work/core/research/browser-policy";
import {
  browserFetch,
  type BrowserAdapterDeps,
  type BrowserFetchInput,
} from "./agent-browser-adapter";

/// 一次 run 调用的记录。
interface RunCall {
  binary: string;
  args: string[];
}

/// 从完整参数序列里取出动作片段（"--json" 之后的部分）。
function actionOf(args: string[]): string[] {
  return args.slice(args.indexOf("--json") + 1);
}

/// agent-browser --json 的成功信封。
function okJson(data: unknown): string {
  return JSON.stringify({ success: true, data });
}

/// agent-browser --json 的失败信封。
function errJson(error: string): string {
  return JSON.stringify({ success: false, data: null, error });
}

/// 被拒探针的真实输出（U0 S4 实测文案）。
const DENIED_PROBE = errJson(
  "Action 'evaluate' denied by policy: action is not in the allow list",
);

/// 构造一组注入依赖：run 按动作名分派到脚本，其余依赖只做记录。
function makeDeps(script: Partial<Record<string, () => Promise<{ stdout: string; stderr: string; code: number | null }>>>): {
  deps: BrowserAdapterDeps;
  calls: RunCall[];
  written: Array<{ dir: string; content: string; path: string }>;
  removed: string[];
} {
  const calls: RunCall[] = [];
  const written: Array<{ dir: string; content: string; path: string }> = [];
  const removed: string[] = [];

  const deps: BrowserAdapterDeps = {
    run: async (binary, args) => {
      calls.push({ binary, args });
      const action = actionOf(args)[0] ?? "";
      const handler = script[action];
      if (!handler) return { stdout: okJson({}), stderr: "", code: 0 };
      return handler();
    },
    writePolicyFile: async (dir, content) => {
      const path = `${dir}/policy.json`;
      written.push({ dir, content, path });
      return path;
    },
    removePath: async (path) => {
      removed.push(path);
    },
    randomToken: () => "tok_fixed",
  };

  return { deps, calls, written, removed };
}

const INPUT: BrowserFetchInput = {
  url: "https://example.com/article",
  sessionId: "sess_01",
  allowedDomains: ["example.com"],
  binary: "/opt/agent-browser",
  policyDir: "/var/research/browser-policy",
};

const READ_OK = okJson({
  url: "https://example.com/article",
  title: "Example Article",
  text: "正文内容",
  source: "html-fallback",
  lifecycle: { launched: false },
});

describe("browserFetch fail-open 自检", () => {
  it("探针被 policy 拒绝时才继续抓取", async () => {
    const { deps, calls } = makeDeps({
      eval: async () => ({ stdout: DENIED_PROBE, stderr: "", code: 1 }),
      open: async () => ({ stdout: okJson({ url: INPUT.url }), stderr: "", code: 0 }),
      read: async () => ({ stdout: READ_OK, stderr: "", code: 0 }),
    });

    const result = await browserFetch(INPUT, deps);

    expect(result.ok).toBe(true);
    // open 是抓取的第一步（先导航再读，见「抓取先导航后读取」一节）。
    expect(calls.map((call) => actionOf(call.args)[0])).toEqual(["eval", "open", "wait", "read", "close"]);
  });

  it("探针未被拒绝时 fail closed，且绝不发起 read", async () => {
    const { deps, calls } = makeDeps({
      // U0 S4a：畸形/缺失的 policy 文件会被 agent-browser 静默忽略，eval 照常成功。
      eval: async () => ({ stdout: okJson({ result: 2 }), stderr: "", code: 0 }),
      read: async () => ({ stdout: READ_OK, stderr: "", code: 0 }),
    });

    const result = await browserFetch(INPUT, deps);

    expect(result).toMatchObject({ ok: false, code: "policy_not_enforced" });
    expect(calls.map((call) => actionOf(call.args)[0])).not.toContain("read");
  });

  it("探针进程异常（无法确认策略生效）同样 fail closed", async () => {
    const { deps, calls } = makeDeps({
      eval: async () => {
        throw new Error("spawn ENOENT");
      },
      read: async () => ({ stdout: READ_OK, stderr: "", code: 0 }),
    });

    const result = await browserFetch(INPUT, deps);

    expect(result).toMatchObject({ ok: false, code: "policy_not_enforced" });
    expect(calls.map((call) => actionOf(call.args)[0])).not.toContain("read");
  });

  it("探针失败但错误文案不含 denied by policy 时不算生效", async () => {
    const { deps } = makeDeps({
      eval: async () => ({ stdout: errJson("Evaluation failed: syntax error"), stderr: "", code: 1 }),
    });

    const result = await browserFetch(INPUT, deps);
    expect(result).toMatchObject({ ok: false, code: "policy_not_enforced" });
  });
});

describe("browserFetch 生命周期", () => {
  it("成功路径写 policy 文件、调 close、删 policy 文件", async () => {
    const { deps, calls, written, removed } = makeDeps({
      eval: async () => ({ stdout: DENIED_PROBE, stderr: "", code: 1 }),
      read: async () => ({ stdout: READ_OK, stderr: "", code: 0 }),
    });

    const result = await browserFetch(INPUT, deps);

    expect(result).toMatchObject({
      ok: true,
      title: "Example Article",
      text: "正文内容",
      browserLaunched: false,
    });
    expect(written).toHaveLength(1);
    expect(written[0]?.dir).toBe(INPUT.policyDir);
    expect(JSON.parse(written[0]?.content ?? "{}")).toEqual(buildReadOnlyActionPolicy());
    expect(actionOf(calls.at(-1)?.args ?? [])).toEqual(["close"]);
    expect(removed).toEqual([written[0]?.path]);
  });

  it("抓取抛错时 close 与删文件仍然执行", async () => {
    const { deps, calls, removed, written } = makeDeps({
      eval: async () => ({ stdout: DENIED_PROBE, stderr: "", code: 1 }),
      read: async () => {
        throw new Error("browser crashed");
      },
    });

    const result = await browserFetch(INPUT, deps);

    expect(result).toMatchObject({ ok: false, code: "browser_error" });
    expect(calls.map((call) => actionOf(call.args)[0])).toContain("close");
    expect(removed).toEqual([written[0]?.path]);
  });

  it("close 自身抛错不掩盖抓取结果，policy 文件照样删", async () => {
    const { deps, removed } = makeDeps({
      eval: async () => ({ stdout: DENIED_PROBE, stderr: "", code: 1 }),
      read: async () => ({ stdout: READ_OK, stderr: "", code: 0 }),
      close: async () => {
        throw new Error("close failed");
      },
    });

    const result = await browserFetch(INPUT, deps);

    expect(result.ok).toBe(true);
    expect(removed).toHaveLength(1);
  });
});

describe("browserFetch 前置 URL 策略", () => {
  it.each([
    ["http://169.254.169.254/latest/meta-data/", "云元数据"],
    ["file:///etc/passwd", "非 http scheme"],
    ["https://user:pw@example.com/x", "含 userinfo"],
    ["https://example.com:8080/x", "非法端口"],
    ["https://evil.example/x", "不在 allowedDomains 内"],
  ])("%s 被拒时根本不调 run（%s）", async (url) => {
    const { deps, calls, written } = makeDeps({});

    const result = await browserFetch({ ...INPUT, url }, deps);

    expect(result).toMatchObject({ ok: false, code: "blocked_by_policy" });
    expect(calls).toHaveLength(0);
    expect(written).toHaveLength(0);
  });
});

describe("browserFetch 参数拼装失败", () => {
  it("allowedDomains 为空时 fail closed，不写文件也不起进程", async () => {
    const { deps, calls, written } = makeDeps({});

    const result = await browserFetch({ ...INPUT, allowedDomains: [] }, deps);

    expect(result).toMatchObject({ ok: false, code: "blocked_by_policy" });
    expect(calls).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it("非法域名条目导致拼装抛错时，已写的 policy 文件被删掉", async () => {
    const { deps, calls, written, removed } = makeDeps({});

    // 第一个条目能通过 checkUrlPolicy 的白名单匹配，第二个条目在拼装参数时才被判非法。
    const result = await browserFetch(
      { ...INPUT, allowedDomains: ["example.com", "evil.com --headed"] },
      deps,
    );

    expect(result).toMatchObject({ ok: false, code: "browser_error" });
    expect(calls).toHaveLength(0);
    expect(removed).toEqual([written[0]?.path]);
  });
});

describe("browserFetch 参数序列", () => {
  it("每次 run 的参数都以 buildAgentBrowserArgs 的结果为前缀", async () => {
    const { deps, calls, written } = makeDeps({
      eval: async () => ({ stdout: DENIED_PROBE, stderr: "", code: 1 }),
      open: async () => ({ stdout: okJson({ url: INPUT.url }), stderr: "", code: 0 }),
      read: async () => ({ stdout: READ_OK, stderr: "", code: 0 }),
    });

    await browserFetch(INPUT, deps);

    const expected = buildAgentBrowserArgs({
      sessionToken: "tok_fixed",
      namespace: "cortex-research-sess_01",
      allowedDomains: INPUT.allowedDomains,
      policyPath: written[0]?.path ?? "",
    });
    // eval(探针) → open(导航) → wait(networkidle) → read → close，五次调用共用同一份前缀参数。
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.binary).toBe(INPUT.binary);
      expect(call.args.slice(0, expected.length)).toEqual(expected);
    }
  });
});

describe("browserFetch 输出解析", () => {
  it("agent-browser 报域名拦截时映射为 blocked_by_policy", async () => {
    const { deps } = makeDeps({
      eval: async () => ({ stdout: DENIED_PROBE, stderr: "", code: 1 }),
      read: async () => ({
        stdout: errJson("Domain 'cdn.example.net' is not in the allowed domains list"),
        stderr: "",
        code: 1,
      }),
    });

    const result = await browserFetch(INPUT, deps);
    expect(result).toMatchObject({ ok: false, code: "blocked_by_policy" });
  });

  it("正文为空时返回 empty_content，不用标题顶替", async () => {
    const { deps } = makeDeps({
      eval: async () => ({ stdout: DENIED_PROBE, stderr: "", code: 1 }),
      read: async () => ({ stdout: okJson({ title: "只有标题", text: "   " }), stderr: "", code: 0 }),
    });

    const result = await browserFetch(INPUT, deps);
    expect(result).toMatchObject({ ok: false, code: "empty_content" });
  });

  it("输出不是 JSON 时返回 browser_error", async () => {
    const { deps } = makeDeps({
      eval: async () => ({ stdout: DENIED_PROBE, stderr: "", code: 1 }),
      read: async () => ({ stdout: "not json at all", stderr: "", code: 0 }),
    });

    const result = await browserFetch(INPUT, deps);
    expect(result).toMatchObject({ ok: false, code: "browser_error" });
  });
});

describe("browserFetch 取消与超时", () => {
  it("已取消的 signal 直接返回 cancelled 且不调 run", async () => {
    const { deps, calls } = makeDeps({});
    const controller = new AbortController();
    controller.abort();

    const result = await browserFetch(INPUT, deps, controller.signal);

    expect(result).toMatchObject({ ok: false, code: "cancelled" });
    expect(calls).toHaveLength(0);
  });

  it("超时返回 timeout 并仍然收尾", async () => {
    const hang = async (
      _binary: string,
      _args: string[],
      signal: AbortSignal,
    ): Promise<{ stdout: string; stderr: string; code: number | null }> =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });

    const removed: string[] = [];
    const result = await browserFetch(
      { ...INPUT, timeoutMs: 5 },
      {
        run: async (binary, args, signal) => {
          // 收尾用的 close 走独立信号，不应被已超时的主信号拖死。
          if (actionOf(args)[0] === "close") return { stdout: okJson({}), stderr: "", code: 0 };
          return hang(binary, args, signal);
        },
        writePolicyFile: async (dir) => `${dir}/policy.json`,
        removePath: async (path) => {
          removed.push(path);
        },
        randomToken: () => "tok_fixed",
      },
    );

    expect(result).toMatchObject({ ok: false, code: "timeout" });
    expect(removed).toHaveLength(1);
  });

  it("抓取中途被外部取消时返回 cancelled", async () => {
    const controller = new AbortController();
    const result = await browserFetch(
      INPUT,
      {
        run: async (_binary, args, signal) => {
          if (actionOf(args)[0] === "eval") {
            return { stdout: DENIED_PROBE, stderr: "", code: 1 };
          }
          if (actionOf(args)[0] === "close") return { stdout: okJson({}), stderr: "", code: 0 };
          controller.abort();
          // 真实 runner（execFile + signal）对「进入时已 abort」会立刻失败，替身必须同样处理，
          // 否则会永远挂着等一个永不再触发的 abort 事件。
          return new Promise((_resolve, reject) => {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
        writePolicyFile: async (dir) => `${dir}/policy.json`,
        removePath: async () => {},
        randomToken: () => "tok_fixed",
      },
      controller.signal,
    );

    expect(result).toMatchObject({ ok: false, code: "cancelled" });
  });
});

/// 回归：抓取必须**先导航再读**，不能只发一次 `read <url>`。
///
/// `read <url>` 走的是 agent-browser 自带的 HTTP 客户端（source: "html-fallback"），
/// **根本不启动 Chrome**。而 Browser 兜底存在的全部理由就是「纯 HTTP 拿不到」——
/// 403 / 429 会原样再吃一次，JS 渲染页拿到空正文。实测同一页：
/// `read <url>` → 0 字（html-fallback）；`open` 后再 `read` → 3188 字（active-tab-html）。
describe("抓取先导航后读取", () => {
  it("参数序列是 eval(探针) → open → read → close，且 open 带 URL、read 不带", async () => {
    const { deps, calls } = makeDeps({
      eval: async () => ({ stdout: DENIED_PROBE, stderr: "", code: 1 }),
      open: async () => ({ stdout: okJson({ url: INPUT.url }), stderr: "", code: 0 }),
      read: async () => ({ stdout: READ_OK, stderr: "", code: 0 }),
    });

    const result = await browserFetch(INPUT, deps);

    expect(result.ok).toBe(true);
    expect(calls.map((call) => actionOf(call.args)[0])).toEqual(["eval", "open", "wait", "read", "close"]);
    expect(actionOf(calls[1]!.args)).toEqual(["open", INPUT.url]);
    // read 不带 URL：带了 agent-browser 会重新用 HTTP 客户端抓，白费前面那次导航。
    expect(actionOf(calls[2]!.args)).toEqual(["wait", "--load", "networkidle"]);
    expect(actionOf(calls[3]!.args)).toEqual(["read"]);
  });

  it("导航失败时不再读取，直接返回失败（避免读到上一页的残留内容）", async () => {
    const { deps, calls } = makeDeps({
      eval: async () => ({ stdout: DENIED_PROBE, stderr: "", code: 1 }),
      open: async () => ({ stdout: errJson("Navigation failed with HTTP 403"), stderr: "", code: 1 }),
    });

    const result = await browserFetch(INPUT, deps);

    expect(result.ok).toBe(false);
    expect(calls.map((call) => actionOf(call.args)[0])).toEqual(["eval", "open", "close"]);
  });
});
