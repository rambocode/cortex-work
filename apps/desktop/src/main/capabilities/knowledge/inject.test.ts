import { describe, expect, it, vi, beforeEach } from "vitest";

// safeStorage 解密走 electron，单测里替身掉：加密态用 "enc:" 前缀表示，解密即去前缀。
// 这样门控与 URL 拼接逻辑可以完整测掉，不必起 Electron。
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    decryptString: (buf: Buffer) => {
      const s = buf.toString("utf8");
      return s.startsWith("enc:") ? s.slice(4) : "";
    },
  },
}));

import { buildKnowledgeMcpServerConfig, normalizeKnowledgeBaseUrl } from "./inject";

/// 把明文令牌编成本测试里的「密文」（对应上面的 mock 解密规则）。
const enc = (token: string) => Buffer.from(`enc:${token}`, "utf8").toString("base64");

const full = { enabled: true, baseUrl: "http://kb.internal:8501", encryptedToken: enc("kbmcp_x") };

describe("normalizeKnowledgeBaseUrl", () => {
  it("只填主机名时补默认的 /api/mcp", () => {
    expect(normalizeKnowledgeBaseUrl("http://kb:8501")).toBe("http://kb:8501/api/mcp");
  });

  it("容忍尾部斜杠（尾斜杠不算填了路径）", () => {
    expect(normalizeKnowledgeBaseUrl("http://kb:8501/")).toBe("http://kb:8501/api/mcp");
    expect(normalizeKnowledgeBaseUrl("http://kb:8501///")).toBe("http://kb:8501/api/mcp");
  });

  // 用户很可能直接从 kbserver 的 CLI 输出里整段复制过来，那串已经带 /api/mcp。
  // 不容错的话会拼成 /api/mcp/api/mcp，表现为「配好了但连不上」，且极难自查。
  it("已含 /api/mcp 时不重复拼接", () => {
    expect(normalizeKnowledgeBaseUrl("http://kb:8501/api/mcp")).toBe("http://kb:8501/api/mcp");
    expect(normalizeKnowledgeBaseUrl("http://kb:8501/api/mcp/")).toBe("http://kb:8501/api/mcp");
  });

  // 回归用例：第三方知识库的端点未必在 /api/mcp。旧实现无条件拼后缀，
  // 把 /mcp 拼成 /mcp/api/mcp，前置 nginx 回 405，用户在界面上无法绕开。
  it("用户填了自定义路径时原样保留，不再拼后缀", () => {
    expect(normalizeKnowledgeBaseUrl("https://wiki.example.com/mcp")).toBe("https://wiki.example.com/mcp");
    expect(normalizeKnowledgeBaseUrl("https://wiki.example.com/mcp/")).toBe("https://wiki.example.com/mcp");
    expect(normalizeKnowledgeBaseUrl("https://host/a/b/mcp")).toBe("https://host/a/b/mcp");
  });

  // 畸形输入不在这里报错：原样回传，由 buildKnowledgeMcpServerConfig 的 scheme 白名单拦下
  // （漏 scheme 的 "kb.internal:8501" 会被 URL 解析成 scheme=kb.internal、path=8501，同样不该补后缀）。
  it("畸形地址原样返回，不拼后缀", () => {
    expect(normalizeKnowledgeBaseUrl("kb.internal:8501")).toBe("kb.internal:8501");
    expect(normalizeKnowledgeBaseUrl("随便一段不是地址的字")).toBe("随便一段不是地址的字");
  });

  it("空值返回空串", () => {
    expect(normalizeKnowledgeBaseUrl("")).toBe("");
    expect(normalizeKnowledgeBaseUrl("   ")).toBe("");
  });
});

describe("buildKnowledgeMcpServerConfig 三门控", () => {
  beforeEach(() => vi.clearAllMocks());

  it("配置齐全时注入 http server，令牌走 Authorization 头", () => {
    const cfg = buildKnowledgeMcpServerConfig(full);
    expect(cfg).not.toBeNull();
    expect(cfg!.id).toBe("cortex-knowledge");
    expect(cfg!.transport).toBe("http");
    expect(cfg!.url).toBe("http://kb.internal:8501/api/mcp");
    expect(cfg!.headers?.Authorization).toBe("Bearer kbmcp_x");
  });

  it("未配置 → 不注入", () => {
    expect(buildKnowledgeMcpServerConfig(undefined)).toBeNull();
  });

  it("总开关关闭 → 不注入", () => {
    expect(buildKnowledgeMcpServerConfig({ ...full, enabled: false })).toBeNull();
  });

  it("baseUrl 为空 → 不注入", () => {
    expect(buildKnowledgeMcpServerConfig({ ...full, baseUrl: "" })).toBeNull();
    expect(buildKnowledgeMcpServerConfig({ ...full, baseUrl: "   " })).toBeNull();
  });

  // 没有令牌就注入的话，Agent 会拿到一整套知识库工具、每次调用都 401，
  // 然后反复重试把这轮对话烧掉。不注入的话它压根不知道有这个能力（同 research/inject.ts 的理由）。
  it("未配置令牌 → 不注入", () => {
    expect(buildKnowledgeMcpServerConfig({ ...full, encryptedToken: undefined })).toBeNull();
  });

  it("令牌解密失败 → 不注入", () => {
    const broken = { ...full, encryptedToken: Buffer.from("垃圾数据", "utf8").toString("base64") };
    expect(buildKnowledgeMcpServerConfig(broken)).toBeNull();
  });

  // 非 http(s) 的 URL 是明确的配置错误（也堵掉 file:// 之类的诡异 scheme）。
  it("非 http/https scheme → 不注入", () => {
    expect(buildKnowledgeMcpServerConfig({ ...full, baseUrl: "file:///etc/passwd" })).toBeNull();
    expect(buildKnowledgeMcpServerConfig({ ...full, baseUrl: "不是URL" })).toBeNull();
  });
});
