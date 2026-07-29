// 公司知识库 MCP server 的注入配置构建（对照 capabilities/research/inject.ts）。
//
// **与其它内置能力的根本差异**：server 不在本地。它跑在公司知识库服务端
// （kbserver 的 /api/mcp，Go 原生 Streamable HTTP），所以这里既不需要 createMcpHost，
// 也没有 port / serverAvailable 这类本地运行时状态——只需构造「连哪儿 + 带什么令牌」。
//
// 这么分工的收益：一次部署全员生效；kb_ask 在服务端直接调 RAG 服务，省掉 SSE 聚合；
// 检索质量调优留在知识库自己的领域内。
//
// **三门控**，缺任一条都返回 null（不注入）：
//   1. 总开关要开；
//   2. baseUrl 要填且是合法的 http(s) 地址；
//   3. 令牌要配好且能解密成功。
//
// 第 3 条尤其不能省。没有它，一个没配令牌的用户会拿到一整套知识库工具，而每次调用
// 都是 401——Agent 会反复重试、把这轮对话烧掉，用户只看到"知识库坏了"。
// 不注入的话，Agent 压根不知道有这个能力，行为退回到从前。（同 research/inject.ts:9-11）
//
// 鉴权：令牌经 Authorization 头（claude headers / codex http_headers / pi 桥接），
// **不进 URL**——URL 会进日志和进程参数。
import { safeStorage } from "electron";

import { createLogger } from "../../log";
import type { KnowledgeBaseSettings, McpServerConfig } from "../../ipc/types";

const log = createLogger("knowledge-inject");

/// 注入用 server id（= MCP server 名）。须为 TOML 裸键安全（见 mcp-config.isValidServerId）。
export const KNOWLEDGE_SERVER_ID = "cortex-knowledge";

/// 知识库服务端固定的 MCP 端点路径（与 kbserver 的 kb.McpEndpointPath 对齐，跨仓库契约）。
const MCP_PATH = "/api/mcp";

/// 把用户填的基址归一化成完整的 MCP 端点 URL。
///
/// 容忍两类常见输入：尾部斜杠，以及**整段从 kbserver CLI 输出里复制过来、已经带 /api/mcp 的地址**。
/// 后者不容错就会拼成 /api/mcp/api/mcp，表现为「配好了却连不上」，且用户几乎不可能自查出来。
export function normalizeKnowledgeBaseUrl(baseUrl: string): string {
  const trimmed = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith(MCP_PATH) ? trimmed : `${trimmed}${MCP_PATH}`;
}

/// 解密 safeStorage 密文。失败返回 null 而不是抛错——钥匙串不可用时应表现为「未配置」
/// （于是不注入），而不是让整条 agent 启动链路挂掉。
function decryptToken(encrypted: string | undefined): string | null {
  if (!encrypted) return null;
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const plain = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    return plain.trim() || null;
  } catch {
    return null;
  }
}

/// 构建知识库 MCP server 的注入配置；不满足门控时返回 null（不注入）。
///
/// @param settings 当前知识库设置快照（来自 getPersistedState 的原始切片）
export function buildKnowledgeMcpServerConfig(
  settings: KnowledgeBaseSettings | undefined,
): McpServerConfig | null {
  if (!settings?.enabled) return null;

  const url = normalizeKnowledgeBaseUrl(settings.baseUrl);
  if (!url) {
    log.debug("不注入：未填写知识库地址");
    return null;
  }
  // scheme 白名单：挡掉 file:// 等诡异 scheme 与压根不是 URL 的输入。
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      log.warn(`不注入：知识库地址 scheme 非 http(s)（${parsed.protocol}）`);
      return null;
    }
  } catch {
    log.warn("不注入：知识库地址不是合法 URL");
    return null;
  }

  const token = decryptToken(settings.encryptedToken);
  if (!token) {
    // 这条日志是刻意留的：门控在主进程静默返回 null，用户那侧只看到「开了知识库但
    // agent 没有检索工具」，没有任何线索可循。
    log.debug("不注入：MCP 令牌未配置或解密失败");
    return null;
  }

  log.debug(`注入知识库 MCP：${url}`);
  return {
    id: KNOWLEDGE_SERVER_ID,
    label: "公司知识库",
    transport: "http",
    url,
    headers: { Authorization: `Bearer ${token}` },
  };
}
