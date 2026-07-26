// Search Server 凭据写入与连通性探测的单测。
//
// 这两件事是设置页「保存令牌 / 连接测试」两个按钮背后的全部逻辑，风险点各不同：
//   - 写入：**绝不能把明文 PAT 落进 personal-workspace.json**（那是明文 JSON），
//     也不能在只改地址时把已存密文抹掉；
//   - 探测：错误分类要能指导用户下一步动作，且**任何对外文本都不得含 token**。
import { describe, expect, it, vi } from "vitest";
import { SearchServerError } from "./clients/search-server-client";
import {
  mergeDirectSearchSettings,
  mergeSearchServerSettings,
  probeDirectSearch,
  probeSearchServer,
} from "./search-credential";

describe("mergeSearchServerSettings", () => {
  it("写入密文并归一化地址与工作区", () => {
    const merged = mergeSearchServerSettings(undefined, {
      baseUrl: "  http://127.0.0.1:28080  ",
      workspaceId: "  ws-1  ",
      encryptedToken: "Y2lwaGVy",
    });
    expect(merged).toEqual({
      baseUrl: "http://127.0.0.1:28080",
      workspaceId: "ws-1",
      encryptedToken: "Y2lwaGVy",
    });
  });

  it("未提供新密文时保留原有密文（只改地址不该把令牌弄丢）", () => {
    const merged = mergeSearchServerSettings(
      { baseUrl: "http://old", workspaceId: "ws-0", encryptedToken: "b2xk" },
      { baseUrl: "http://new", workspaceId: "ws-1" },
    );
    expect(merged.encryptedToken).toBe("b2xk");
    expect(merged.baseUrl).toBe("http://new");
    expect(merged.workspaceId).toBe("ws-1");
  });

  it("既无新密文也无旧密文时不产生 encryptedToken 字段", () => {
    const merged = mergeSearchServerSettings(undefined, { baseUrl: "http://x", workspaceId: "w" });
    expect("encryptedToken" in merged).toBe(false);
  });
});

describe("probeSearchServer", () => {
  /// 探测成功：客户端正常返回即算通。这里不校验结果条数——0 条是「搜索后端没结果」，
  /// 不是「连接不通」，把两者混为一谈会让用户去改一个没问题的配置。
  it("成功时 ok=true，并把返回条数写进提示", async () => {
    const searchBatch = vi.fn().mockResolvedValue({
      request_id: "probe",
      results: [{ query_id: "probe", items: [{ url: "https://a" }, { url: "https://b" }], errors: [] }],
      stats: { provider_count: 1, raw_result_count: 2, returned_result_count: 2, cache_hit: false, duration_ms: 12 },
    });
    const probe = await probeSearchServer({ searchBatch });
    expect(probe.ok).toBe(true);
    expect(probe.message).toContain("连接正常");
    expect(probe.message).toContain("2");
  });

  it("零结果仍算连接成功，但提示里说明没搜到内容", async () => {
    const searchBatch = vi.fn().mockResolvedValue({
      request_id: "probe",
      results: [{ query_id: "probe", items: [], errors: [] }],
      stats: { provider_count: 1, raw_result_count: 0, returned_result_count: 0, cache_hit: false, duration_ms: 8 },
    });
    const probe = await probeSearchServer({ searchBatch });
    expect(probe.ok).toBe(true);
    expect(probe.message).toContain("未搜到");
  });

  /// 每种错误码都要给出**可执行的下一步**，而不是把英文错误码丢给用户。
  const cases: Array<{ err: SearchServerError; expect: string }> = [
    { err: new SearchServerError("unauthorized", "401", 401), expect: "令牌无效" },
    { err: new SearchServerError("forbidden", "403", 403), expect: "无权访问" },
    { err: new SearchServerError("http_error", "404", 404), expect: "工作区" },
    { err: new SearchServerError("unavailable", "503", 503), expect: "搜索后端" },
    { err: new SearchServerError("network_error", "ECONNREFUSED"), expect: "连不上" },
    { err: new SearchServerError("cancelled", "timeout"), expect: "超时" },
    { err: new SearchServerError("invalid_response", "bad json"), expect: "响应" },
  ];
  for (const c of cases) {
    it(`${c.err.code} → ok=false 且提示含「${c.expect}」`, async () => {
      const searchBatch = vi.fn().mockRejectedValue(c.err);
      const probe = await probeSearchServer({ searchBatch });
      expect(probe.ok).toBe(false);
      expect(probe.message).toContain(c.expect);
    });
  }

  /// 红线：探测失败的文本会显示在设置页并可能被截图外发，绝不能含凭据。
  it("服务端把 token 回显进错误体时，探测文本里不得出现 token", async () => {
    const TOKEN = "mul_secret_token_value";
    const searchBatch = vi
      .fn()
      .mockRejectedValue(new SearchServerError("http_error", `upstream said: Bearer ${TOKEN}`, 500));
    const probe = await probeSearchServer({ searchBatch }, TOKEN);
    expect(probe.ok).toBe(false);
    expect(probe.message).not.toContain(TOKEN);
  });

  it("非 SearchServerError 的意外异常也要被兜住，不外泄栈", async () => {
    const searchBatch = vi.fn().mockRejectedValue(new Error("boom"));
    const probe = await probeSearchServer({ searchBatch });
    expect(probe.ok).toBe(false);
    expect(probe.message).toContain("测试失败");
  });

  /// 探测请求本身也是一份契约：查询数必须是 1（别为一次连通性测试烧掉 8 条 provider 调用），
  /// 且 limit 取 1。
  it("探测只发一条查询且 limit=1", async () => {
    const searchBatch = vi.fn().mockResolvedValue({
      request_id: "probe",
      results: [],
      stats: { provider_count: 1, raw_result_count: 0, returned_result_count: 0, cache_hit: false, duration_ms: 1 },
    });
    await probeSearchServer({ searchBatch });
    const req = searchBatch.mock.calls[0]![0];
    expect(req.queries).toHaveLength(1);
    expect(req.queries[0].limit).toBe(1);
  });
});

describe("mergeDirectSearchSettings", () => {
  it("写入密文", () => {
    const merged = mergeDirectSearchSettings(undefined, {
      provider: "brave",
      encryptedApiKey: "Y2lwaGVy",
    });
    expect(merged).toEqual({ provider: "brave", encryptedApiKey: "Y2lwaGVy" });
  });

  it("同一供应商下未提供新密文时保留原有密文", () => {
    const merged = mergeDirectSearchSettings(
      { provider: "brave", encryptedApiKey: "b2xk" },
      { provider: "brave" },
    );
    expect(merged.encryptedApiKey).toBe("b2xk");
  });

  it("换供应商且未提供新密文时**丢弃**旧密文（brave 的 key 在 tavily 上必然无效）", () => {
    const merged = mergeDirectSearchSettings(
      { provider: "brave", encryptedApiKey: "b2xk" },
      { provider: "tavily" },
    );
    expect(merged.provider).toBe("tavily");
    expect("encryptedApiKey" in merged).toBe(false);
  });

  it("既无新密文也无旧密文时不产生 encryptedApiKey 字段", () => {
    const merged = mergeDirectSearchSettings(undefined, { provider: "tavily" });
    expect("encryptedApiKey" in merged).toBe(false);
  });
});

describe("probeDirectSearch", () => {
  /// 直连客户端**不抛错**，失败在响应体的 errors 里。probeSearchServer 那套
  /// 「没抛错就算通」的判定在这里会把「key 无效」报成「连接正常但没搜到内容」，
  /// 所以必须单独一套判定 —— 这正是本函数存在的理由。
  it("有结果时 ok=true", async () => {
    const searchBatch = vi.fn().mockResolvedValue({
      request_id: "probe",
      results: [{ query_id: "probe", items: [{ url: "https://a" }], errors: [] }],
      stats: { provider_count: 1, raw_result_count: 1, returned_result_count: 1, cache_hit: false, duration_ms: 9 },
    });
    const probe = await probeDirectSearch({ searchBatch }, "brave");
    expect(probe.ok).toBe(true);
    expect(probe.message).toContain("连接正常");
  });

  it.each([
    ["unauthorized", /密钥无效|无效/],
    ["forbidden", /额度|无权/],
    ["rate_limited", /限流/],
    ["network_error", /连不上|网络/],
    ["timeout", /超时/],
  ])("响应体里的 %s 被识别为失败", async (code, matcher) => {
    const searchBatch = vi.fn().mockResolvedValue({
      request_id: "probe",
      results: [{ query_id: "probe", items: [], errors: [{ provider: "brave", code }] }],
      stats: { provider_count: 1, raw_result_count: 0, returned_result_count: 0, cache_hit: false, duration_ms: 9 },
    });
    const probe = await probeDirectSearch({ searchBatch }, "brave");
    expect(probe.ok).toBe(false);
    expect(probe.message).toMatch(matcher);
  });

  it("无错误但零结果算成功（那是搜索本身没命中，不是配置错）", async () => {
    const searchBatch = vi.fn().mockResolvedValue({
      request_id: "probe",
      results: [{ query_id: "probe", items: [], errors: [] }],
      stats: { provider_count: 1, raw_result_count: 0, returned_result_count: 0, cache_hit: false, duration_ms: 9 },
    });
    const probe = await probeDirectSearch({ searchBatch }, "brave");
    expect(probe.ok).toBe(true);
  });

  it("客户端抛出（取消 / 意外异常）时兜住，不外泄栈", async () => {
    const searchBatch = vi.fn().mockRejectedValue(new Error("boom"));
    const probe = await probeDirectSearch({ searchBatch }, "brave");
    expect(probe.ok).toBe(false);
    expect(probe.message).toContain("测试失败");
    expect(probe.message).not.toContain("boom");
  });

  it("API key 明文不出现在提示里", async () => {
    const searchBatch = vi.fn().mockRejectedValue(new Error("bad key sk-live-123"));
    const probe = await probeDirectSearch({ searchBatch }, "brave", "sk-live-123");
    expect(probe.message).not.toContain("sk-live-123");
  });
});
