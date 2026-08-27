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

/// 自家 kbserver 的 MCP 端点路径（与 kbserver 的 kb.McpEndpointPath 对齐，跨仓库契约）。
/// **只是默认值**，不是唯一合法路径——见 normalizeKnowledgeBaseUrl。
const DEFAULT_MCP_PATH = "/api/mcp";

/// 把用户填的地址归一化成完整的 MCP 端点 URL。
///
/// 规则只有一条：**用户填了路径就原样用，只有没填路径时才补默认的 `/api/mcp`**。
///
/// 为什么不能无条件拼后缀（旧实现的做法）：第三方知识库的端点路径未必是 `/api/mcp`，
/// 实测某企业 wiki 的 MCP 端点就在 `/mcp`。无条件拼会把 `https://host/mcp` 变成
/// `https://host/mcp/api/mcp`，请求打到不存在的路径上、由前置 nginx 回 **405 Not Allowed**，
/// 而用户在设置界面上**没有任何填法能绕开**（只有正好以 /api/mcp 结尾才不拼），只能改代码。
///
/// 反过来，「没填路径 → 补 /api/mcp」保留了自家 kbserver 用户只填主机名的便利；
/// 而「整段从 kbserver CLI 输出复制过来、已带 /api/mcp」的老场景，现在天然落进
/// 「填了路径 → 原样用」这一支，同样不会拼成 /api/mcp/api/mcp。
export function normalizeKnowledgeBaseUrl(baseUrl: string): string {
  const trimmed = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    // 只借 URL 解析判断「有没有填路径」；非法输入不在这里报错，交给调用方的 scheme 白名单拦。
    const { pathname } = new URL(trimmed);
    return pathname && pathname !== "/" ? trimmed : `${trimmed}${DEFAULT_MCP_PATH}`;
  } catch {
    // 不是合法 URL（如漏了 scheme）：原样返回，让上游给出「地址不是合法 URL」而不是拼出更怪的串。
    return trimmed;
  }
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
