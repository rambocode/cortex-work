// 知识库 MCP server 的**能力探测与角色映射**。
//
// **为什么需要这一层**：早期实现把工具名写死成 `kb_search` / `kb_read_doc` 这套自家约定——
// prompt 里写死、UI 判定写死、引用预览也写死。接第三方知识库时立刻崩：某企业 wiki 的
// 工具叫 `search_documents` / `read_document`，坐标叫 `knowledgeBaseId` + `documentPath`，
// 于是「测试连接显示 10 个工具可用」但内置 skill 判定「未接入」、引用预览调不到工具。
//
// 现在改为：连接时跑一次 `tools/list`，把服务端**实际提供的方法**映射到五个语义角色
// （search / read / list / ask / write），再据此动态渲染注入 prompt 的能力块。
// 自家 kbserver 走「精确名命中」这条快路，行为与从前完全一致；第三方走启发式匹配。
//
// **角色映射是本文件的全部价值**：它把「服务端叫什么」与「产品要用它干什么」解耦。
// 下游三个消费方都只认角色，不再认名字：
//   1. prompt 注入块（cli.ts / pi-session.ts）——告诉模型本会话真实可用的工具与用法；
//   2. `kb://` 引用预览（ipc/knowledge.ts 的 readKnowledgeDoc）——需要知道「哪个是读文档」；
//   3. 设置页的只读/可写提示——需要知道「有没有写能力」。
import { createHash } from "node:crypto";

import { createLogger } from "../../log";

const log = createLogger("knowledge-tools");

/// 服务端 tools/list 返回的单个工具（只留渲染 prompt 与推断参数所需的字段）。
export interface KnowledgeToolInfo {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

/// 五个语义角色 → 服务端实际工具名。缺失表示该能力不可用。
export interface KnowledgeToolRoles {
  search?: string;
  read?: string;
  list?: string;
  ask?: string;
  write?: string;
}

/// 一次探测的完整结果：原始工具清单 + 角色映射 + 读工具的定位参数名。
export interface KnowledgeCapabilities {
  tools: KnowledgeToolInfo[];
  roles: KnowledgeToolRoles;
  /// 读文档工具的两个定位参数名（如 ["sourceId","relPath"] 或 ["knowledgeBaseId","documentPath"]）。
  /// `kb://<a>/<b>` 引用链接的两段就按这个顺序映射回工具入参——没有它，第三方知识库的
  /// 引用点开后无法还原成一次合法调用。
  readLocatorParams: string[];
}

/// 自家 kbserver 的约定工具名。**精确命中优先**：这套名字下行为必须与改动前逐字一致，
/// 免得为了兼容第三方把老用户的既有链路带偏。
const CANONICAL: Record<keyof KnowledgeToolRoles, string> = {
  search: "kb_search",
  read: "kb_read_doc",
  list: "kb_list_docs",
  ask: "kb_ask",
  write: "kb_write_doc",
};

/// 启发式关键词。顺序即优先级：同一角色下越靠前的词命中得分越高。
/// 只在精确名没命中时才用——这里天然是「猜」，所以宁可漏（角色为空 → 该能力不进 prompt）
/// 也不要错（把上传工具认成搜索工具，模型会拿它去检索然后一直失败）。
const HEURISTICS: Record<keyof KnowledgeToolRoles, string[]> = {
  search: ["search", "query", "retrieve", "find"],
  read: ["read", "get_content", "get_document", "fetch_document", "content"],
  // 更具体的词排前面：某 wiki 同时有 list_documents 与 list_knowledge_bases，
  // 只按 "list" 匹配的话谁先出现谁赢（实测抢到的是列知识库那个，不是列文档）。
  list: ["list_document", "list_doc", "browse", "list", "index"],
  ask: ["ask", "answer", "rag", "qa"],
  write: ["write", "upload", "create_document", "put_document", "save"],
};

/// 明确排除的工具：名字里带这些词的一律不参与角色映射。
///
/// 为什么要显式排除：企业 wiki 常带 `get_document_download_link`、
/// `list_material_history_versions` 这类周边工具。前者含 "document" 会被 read 的关键词误吞，
/// 后者含 "list" 会顶掉真正的目录工具——一旦映射错，引用预览就会去调一个返回下载链接的
/// 工具然后拿不到正文，而错误信息完全看不出根因。
const EXCLUDE = [
  "download",
  "history_version",
  "delete",
  "remove",
  "create_knowledge_base",
  "directory",
];

/// 分页/定位类参数，不算「文档坐标」。推断 readLocatorParams 时要先剔除它们。
const NON_LOCATOR_PARAMS = new Set([
  "offset",
  "limit",
  "around",
  "page",
  "pageNo",
  "pageSize",
  "cursor",
]);

/// 给单个工具在某角色下打分；0 表示不匹配。
/// 分数只在同一角色内部比较，用来在多个候选里挑一个最像的。
function scoreFor(
  tool: KnowledgeToolInfo,
  role: keyof KnowledgeToolRoles,
): number {
  const name = tool.name.toLowerCase();
  if (EXCLUDE.some((w) => name.includes(w))) return 0;
  const keywords = HEURISTICS[role];
  for (let i = 0; i < keywords.length; i++) {
    if (name.includes(keywords[i])) return keywords.length - i;
  }
  return 0;
}

/// 把服务端工具清单映射成五个语义角色。纯函数，便于单测。
///
/// 两轮：先精确名（自家 kbserver），再启发式挑最高分（第三方）。
/// 同一个工具不会被两个角色抢占——先到先得，避免 `search_documents` 既当 search 又当 list。
export function mapKnowledgeToolRoles(
  tools: KnowledgeToolInfo[],
): KnowledgeToolRoles {
  const roles: KnowledgeToolRoles = {};
  const taken = new Set<string>();
  const byName = new Map(tools.map((t) => [t.name, t]));

  for (const role of Object.keys(CANONICAL) as (keyof KnowledgeToolRoles)[]) {
    const canonical = CANONICAL[role];
    if (byName.has(canonical)) {
      roles[role] = canonical;
      taken.add(canonical);
    }
  }

  for (const role of Object.keys(HEURISTICS) as (keyof KnowledgeToolRoles)[]) {
    if (roles[role]) continue;
    let best: { name: string; score: number } | null = null;
    for (const tool of tools) {
      if (taken.has(tool.name)) continue;
      const score = scoreFor(tool, role);
      if (score > 0 && (!best || score > best.score))
        best = { name: tool.name, score };
    }
    if (best) {
      roles[role] = best.name;
      taken.add(best.name);
    }
  }
  return roles;
}

/// 推断读文档工具的两个定位参数名。
///
/// 规则：取 inputSchema 里排除分页参数后的前两个必需参数；required 缺失时退回 properties 顺序。
/// 推不出来就回退到自家约定 ["sourceId","relPath"]——那是老行为，至少不会更糟。
export function inferReadLocatorParams(
  tool: KnowledgeToolInfo | undefined,
): string[] {
  const schema = tool?.inputSchema;
  const candidates = (
    schema?.required?.length
      ? schema.required
      : Object.keys(schema?.properties ?? {})
  ).filter((p) => !NON_LOCATOR_PARAMS.has(p));
  if (candidates.length >= 2) return candidates.slice(0, 2);
  // 只有一个定位参数（如仅 documentPath）时补一个空位，调用侧会跳过 undefined 的那段。
  if (candidates.length === 1) return [candidates[0]];
  return ["sourceId", "relPath"];
}

/// 从工具清单构造完整能力快照。
export function buildKnowledgeCapabilities(
  tools: KnowledgeToolInfo[],
): KnowledgeCapabilities {
  const roles = mapKnowledgeToolRoles(tools);
  const readTool = tools.find((t) => t.name === roles.read);
  return { tools, roles, readLocatorParams: inferReadLocatorParams(readTool) };
}

// ── 注入 prompt 的能力块 ────────────────────────────────────────────────────

/// 单条工具描述在 prompt 里的截断长度。描述再长模型也不会读出更多信息，
/// 而它每轮都要付 token——企业 wiki 的描述动辄百余字，十个工具就是一大段。
const DESC_LIMIT = 160;

function oneLine(text: string | undefined, limit = DESC_LIMIT): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/// 渲染注入会话系统提示的知识库能力块（**英文**，按仓库约定：发给模型的正文一律英文）。
///
/// **这是「动态注册」的落点**：块里列出的是服务端本次 `tools/list` 真实返回的方法名，
/// 而不是任何写死的约定名。模型据此知道该调什么；内置 skill 只讲策略、不再点名工具。
///
/// 引用链接那段是**按能力开关的**：只有探测到读工具时才要求模型输出 `kb://` 链接，
/// 否则模型会生成一堆点开就报错的死链接——宁可让它写纯文件名。
export function renderKnowledgeToolsBlock(caps: KnowledgeCapabilities): string {
  if (!caps.tools.length) return "";
  const { roles } = caps;
  const lines: string[] = ["<company_knowledge_base>"];
  lines.push(
    "A company knowledge base is connected to this session through the MCP server `cortex-knowledge`.",
    "It is the authoritative source for internal company material. Ground every internal claim in it;",
    "never answer from general knowledge and let it read like company policy.",
    "",
    "Tools available in THIS session (names are discovered from the server, do not guess others):",
  );
  for (const tool of caps.tools) {
    const role = (Object.keys(roles) as (keyof KnowledgeToolRoles)[]).find(
      (r) => roles[r] === tool.name,
    );
    const tag = role ? ` [${role}]` : "";
    lines.push(
      `- ${tool.name}${tag}: ${oneLine(tool.description) || "(no description)"}`,
    );
  }

  lines.push("", "How to use them:");
  if (roles.search) {
    lines.push(
      `- Start with \`${roles.search}\`. One call is usually enough. If it returns nothing, rephrase with`,
      "  different domain wording instead of retrying the same query; after two or three empty attempts,",
      "  tell the user nothing was found — that is a useful answer, not a failure to paper over.",
    );
  }
  if (roles.read) {
    lines.push(
      `- Only call \`${roles.read}\` for the one to three hits that actually matter. Search previews are`,
      "  excerpts, not full documents, but reading every hit in full is the main way to waste context.",
    );
  }
  if (roles.list) {
    lines.push(
      `- Use \`${roles.list}\` only to discover what exists. If you already know what to look for, search directly.`,
    );
  }
  if (roles.ask) {
    lines.push(
      `- \`${roles.ask}\` runs a full server-side RAG pass and is an order of magnitude slower. Use it only when`,
      "  the user wants a direct conclusion and you do not need the source text. Never use it to double-check",
      "  a conclusion you already drew from search results — it reads the same material.",
    );
  }
  if (roles.write) {
    lines.push(
      `- \`${roles.write}\` writes into a shared team space. ALWAYS confirm the exact content with the user first.`,
      "  Write distilled conclusions, not raw transcripts or logs.",
    );
  } else {
    lines.push(
      "- This session has read-only access. If the user asks you to save something, say so plainly.",
    );
  }

  if (roles.read && caps.readLocatorParams.length >= 2) {
    const [a, b] = caps.readLocatorParams;
    lines.push(
      "",
      "Citations: every statement taken from the knowledge base MUST carry a clickable reference in the form",
      `  [file name](kb://<${a}>/<${b}>)`,
      `where <${a}> and <${b}> are the values you would pass to \`${roles.read}\`, copied verbatim from the`,
      "search result. Percent-encode spaces as %20 in the link target (keep other characters as-is); a raw space",
      "breaks the markdown link and the user sees literal `kb://` text. Cite inline where the claim is made,",
      "not as a trailing reference list.",
    );
  } else {
    lines.push(
      "",
      "Citations: name the source document inline for every claim. Do NOT emit kb:// links in this session —",
      "the connected server does not expose a document reader, so such links would not open.",
    );
  }
  lines.push("</company_knowledge_base>");
  return lines.join("\n");
}

// ── 探测结果缓存 ───────────────────────────────────────────────────────────
//
// 为什么要缓存：注入发生在每次会话/回合启动的同步路径上，而 tools/list 是一次跨网络往返
// （超时 15 秒）。在那里等探测会把「起一轮对话」的延迟绑在知识库服务的健康度上。
// 故：注入侧**只读缓存**，探测由「保存配置」「测试连接」这类用户动作预热。
// 缓存没命中就这一轮不注入能力块——MCP 工具本身仍然可用，模型只是少一段用法指引。

/// 缓存键含令牌指纹：换了令牌 scope 可能变（只读令牌看不到写工具），必须重新探测。
function cacheKey(url: string, token: string): string {
  return `${url}#${createHash("sha256").update(token).digest("hex").slice(0, 8)}`;
}

let cached: { key: string; caps: KnowledgeCapabilities } | null = null;

/// 写入缓存（探测成功后调用）。
export function cacheKnowledgeCapabilities(
  url: string,
  token: string,
  tools: KnowledgeToolInfo[],
): KnowledgeCapabilities {
  const caps = buildKnowledgeCapabilities(tools);
  cached = { key: cacheKey(url, token), caps };
  log.debug(
    `知识库能力已缓存：${tools.length} 个工具，角色 ${JSON.stringify(caps.roles)}`,
  );
  return caps;
}

/// 读缓存；键不匹配（改了地址或令牌）返回 null。
export function getCachedKnowledgeCapabilities(
  url: string,
  token: string,
): KnowledgeCapabilities | null {
  if (!cached || cached.key !== cacheKey(url, token)) return null;
  return cached.caps;
}

/// 清空缓存（移除令牌 / 改配置时调用），避免用旧能力渲染新连接的 prompt。
export function clearKnowledgeCapabilitiesCache(): void {
  cached = null;
}

/// 挑一个可用来验证鉴权的**只读、无必需参数**工具名；挑不出返回 null。
///
/// 用途见 ipc/knowledge.ts 的连通性自检：`tools/list` 在不少服务端上**根本不校验鉴权**
/// （实测某企业 wiki 不带任何令牌也照样返回全部工具），所以「握手 + 列工具」通过
/// 并不能证明令牌有效。必须真调一次工具，才谈得上验证。
///
/// 只挑无必需参数的：探针不该因为「少传了 query」而失败，那会把参数问题误报成令牌问题。
export function pickAuthProbeTool(caps: KnowledgeCapabilities): string | null {
  const readOnly = [caps.roles.list, caps.roles.search].filter((n): n is string => Boolean(n));
  for (const name of readOnly) {
    const tool = caps.tools.find((t) => t.name === name);
    if (tool && !(tool.inputSchema?.required?.length ?? 0)) return name;
  }
  // 角色工具都要参数时，退而求其次：任意一个无参且不在排除名单里的工具。
  const fallback = caps.tools.find(
    (t) => !(t.inputSchema?.required?.length ?? 0) && !EXCLUDE.some((w) => t.name.toLowerCase().includes(w)),
  );
  return fallback?.name ?? null;
}

/// 服务端错误文本是否像「鉴权没过」。
///
/// 只用于把探针失败**归类**成「令牌问题」而不是「服务端故障」——两者给用户的下一步动作
/// 完全不同（换令牌 vs 找管理员看服务）。判不准时按非鉴权处理，宁可少报也不误报。
export function looksLikeAuthError(text: string): boolean {
  const t = text.toLowerCase();
  return ["token", "auth", "unauthorized", "forbidden", "401", "403", "认证", "鉴权", "令牌", "未授权", "权限"].some(
    (k) => t.includes(k),
  );
}
