// 角色映射与 prompt 块渲染的单测。
//
// 这两件事是「工具动态注册」的全部要害：映射错了，模型会拿上传工具去检索；
// 块渲染错了，模型会输出一堆点不开的 kb:// 死链接。都属于线上很难归因的故障。
import { describe, expect, it } from "vitest";

import {
  buildKnowledgeCapabilities,
  inferReadLocatorParams,
  looksLikeAuthError,
  mapKnowledgeToolRoles,
  pickAuthProbeTool,
  renderKnowledgeToolsBlock,
  type KnowledgeToolInfo,
} from "./tools";

/// 自家 kbserver 的工具集。
const CANONICAL_TOOLS: KnowledgeToolInfo[] = [
  { name: "kb_search", description: "语义检索" },
  {
    name: "kb_read_doc",
    description: "读正文",
    inputSchema: { properties: { sourceId: {}, relPath: {}, offset: {}, limit: {} }, required: ["sourceId", "relPath"] },
  },
  { name: "kb_list_docs", description: "列目录" },
  { name: "kb_ask", description: "RAG 问答" },
  { name: "kb_write_doc", description: "写入" },
];

/// 某企业 wiki 的真实工具集（实测抓取，含会误导启发式的周边工具）。
const WIKI_TOOLS: KnowledgeToolInfo[] = [
  { name: "list_knowledge_bases", description: "列出可访问的知识库" },
  { name: "create_knowledge_base", description: "创建团队知识库" },
  { name: "list_documents", description: "浏览知识库目录" },
  { name: "create_document_directory", description: "创建目录" },
  { name: "upload_document", description: "上传文档" },
  { name: "search_documents", description: "搜索文档，返回正文命中片段" },
  {
    name: "read_document",
    description: "读取文档正文窗口",
    inputSchema: {
      properties: { knowledgeBaseId: {}, contentId: {}, documentPath: {}, offset: {}, limit: {} },
      required: ["knowledgeBaseId", "documentPath"],
    },
  },
  { name: "get_document_download_link", description: "生成下载链接" },
  { name: "list_material_history_versions", description: "查历史版本" },
  { name: "get_material_history_version_download_link", description: "历史版本下载链接" },
];

describe("mapKnowledgeToolRoles", () => {
  it("自家约定名精确命中五个角色", () => {
    expect(mapKnowledgeToolRoles(CANONICAL_TOOLS)).toEqual({
      search: "kb_search",
      read: "kb_read_doc",
      list: "kb_list_docs",
      ask: "kb_ask",
      write: "kb_write_doc",
    });
  });

  it("第三方 wiki 按启发式映射到正确的工具", () => {
    const roles = mapKnowledgeToolRoles(WIKI_TOOLS);
    expect(roles.search).toBe("search_documents");
    expect(roles.read).toBe("read_document");
    expect(roles.write).toBe("upload_document");
    // list_knowledge_bases 也含 "list"，但列文档的才是 list 角色（更具体的关键词优先）。
    expect(roles.list).toBe("list_documents");
    // 该 wiki 没有 RAG 问答工具，宁可空缺也不能硬凑一个。
    expect(roles.ask).toBeUndefined();
  });

  // 这三个是启发式最容易翻车的地方：名字里都带着别的角色的关键词。
  it("周边工具不被误认成核心角色", () => {
    const roles = mapKnowledgeToolRoles(WIKI_TOOLS);
    const picked = Object.values(roles);
    expect(picked).not.toContain("get_document_download_link"); // 含 document，易被 read 吞掉
    expect(picked).not.toContain("list_material_history_versions"); // 含 list，易顶掉目录工具
    expect(picked).not.toContain("create_knowledge_base"); // 含 create，易被 write 吞掉
  });

  it("同一个工具不会被两个角色同时占用", () => {
    const roles = mapKnowledgeToolRoles(WIKI_TOOLS);
    const picked = Object.values(roles).filter(Boolean);
    expect(new Set(picked).size).toBe(picked.length);
  });

  it("空清单返回空映射", () => {
    expect(mapKnowledgeToolRoles([])).toEqual({});
  });
});

describe("inferReadLocatorParams", () => {
  it("取 required 里排除分页参数后的前两个", () => {
    expect(inferReadLocatorParams(WIKI_TOOLS.find((t) => t.name === "read_document"))).toEqual([
      "knowledgeBaseId",
      "documentPath",
    ]);
  });

  it("没有 schema 时回退到自家约定坐标", () => {
    expect(inferReadLocatorParams(undefined)).toEqual(["sourceId", "relPath"]);
    expect(inferReadLocatorParams({ name: "x" })).toEqual(["sourceId", "relPath"]);
  });

  it("required 缺失时退回 properties 顺序", () => {
    expect(
      inferReadLocatorParams({ name: "x", inputSchema: { properties: { docId: {}, path: {}, limit: {} } } }),
    ).toEqual(["docId", "path"]);
  });
});

describe("renderKnowledgeToolsBlock", () => {
  it("列出真实工具名并给出对应的 kb:// 参数名", () => {
    const block = renderKnowledgeToolsBlock(buildKnowledgeCapabilities(WIKI_TOOLS));
    expect(block).toContain("<company_knowledge_base>");
    expect(block).toContain("search_documents [search]");
    expect(block).toContain("read_document [read]");
    // 引用格式必须用该服务端真实的定位参数名，否则模型生成的链接点开就报错。
    expect(block).toContain("kb://<knowledgeBaseId>/<documentPath>");
    expect(block).not.toContain("kb_search");
  });

  it("自家知识库仍给出 sourceId/relPath 的引用格式", () => {
    const block = renderKnowledgeToolsBlock(buildKnowledgeCapabilities(CANONICAL_TOOLS));
    expect(block).toContain("kb://<sourceId>/<relPath>");
    expect(block).toContain("kb_ask");
  });

  // 没有读工具时输出 kb:// 链接必然点不开，此时要明确禁止模型生成它。
  it("缺读取工具时禁用 kb:// 链接", () => {
    const caps = buildKnowledgeCapabilities([{ name: "search_documents", description: "搜索" }]);
    const block = renderKnowledgeToolsBlock(caps);
    expect(block).toContain("Do NOT emit kb:// links");
    expect(block).not.toContain("MUST carry a clickable reference");
  });

  it("只读接入时明确告知不能写", () => {
    const caps = buildKnowledgeCapabilities(CANONICAL_TOOLS.filter((t) => t.name !== "kb_write_doc"));
    expect(renderKnowledgeToolsBlock(caps)).toContain("read-only access");
  });

  it("无工具时不产出任何块（避免注入一段空指引）", () => {
    expect(renderKnowledgeToolsBlock(buildKnowledgeCapabilities([]))).toBe("");
  });
});

describe("pickAuthProbeTool", () => {
  // 这个探针是「测试连接」能不能测出坏令牌的关键：tools/list 在很多服务端上不校验鉴权。
  it("挑无必需参数的只读工具", () => {
    const caps = buildKnowledgeCapabilities(WIKI_TOOLS);
    expect(pickAuthProbeTool(caps)).toBe("list_documents");
  });

  it("角色工具都要参数时退回任意无参工具", () => {
    const caps = buildKnowledgeCapabilities([
      { name: "search_documents", inputSchema: { required: ["keyword"] } },
      { name: "whoami" },
    ]);
    expect(pickAuthProbeTool(caps)).toBe("whoami");
  });

  it("全都要参数时返回 null（不硬探）", () => {
    const caps = buildKnowledgeCapabilities([
      { name: "search_documents", inputSchema: { required: ["keyword"] } },
    ]);
    expect(pickAuthProbeTool(caps)).toBeNull();
  });
});

describe("looksLikeAuthError", () => {
  // 左边这些是实测抓到的服务端原话（缺 token / token 错 / 带了多余的 Bearer 前缀）。
  it("识别鉴权类错误", () => {
    expect(looksLikeAuthError("缺少有效的 general-system API Token")).toBe(true);
    expect(looksLikeAuthError("Wiki认证失败，requestId=abc")).toBe(true);
    expect(looksLikeAuthError("HTTP 401 Unauthorized")).toBe(true);
  });

  it("不把业务错误误判成鉴权问题", () => {
    expect(looksLikeAuthError("文档不存在")).toBe(false);
    expect(looksLikeAuthError("参数 keyword 不能为空")).toBe(false);
  });
});
