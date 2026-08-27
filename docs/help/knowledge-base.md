# 公司知识库接入指南

面向两类读者：

- **使用者**：拿到管理员给的地址和令牌，把知识库接进 Cortex（第 1–3 节）。
- **管理员 / 自建方**：想把**自己已有的知识库**接进来，需要按什么契约提供 MCP 服务（第 4–6 节）。

---

## 1. 需要在本机安装 MCP server 吗？

**不需要。** 知识库的 MCP server 跑在**服务端**，客户端只做一件事：拿着「地址 + 令牌」去连它。

这样分工的收益：一次部署全员生效，检索质量调优留在知识库自己的领域内，客户端不承担索引与 RAG。

参见 `apps/desktop/src/main/capabilities/knowledge/inject.ts`。

## 2. 令牌是怎么传的？

**放在 HTTP 请求头里，不进 URL：**

```http
Authorization: Bearer <你的 MCP 令牌>
```

URL 会进日志和进程参数，令牌进 URL 等于明文泄露，所以三端一律走请求头：

| 端 | 令牌落点 |
| --- | --- |
| Claude Code | `.mcp.json` → `mcpServers.cortex-knowledge.headers` |
| Codex | `config.toml` → `mcp_servers.cortex-knowledge.http_headers` |
| Cortex（pi） | 进程内 MCP 桥接，直接带头部 |

本机存储：令牌用系统钥匙库（macOS Keychain，Electron `safeStorage`）加密后以 base64 存进 `personal-workspace.json`，**明文既不落盘也不回显**。钥匙库不可用时**拒绝保存**，不会退化成明文写入。

## 3. 使用者：三步接入

设置 → 知识库：

1. **知识库地址**：填到 **MCP 端点为止**，如 `https://wiki.example.com/mcp`。
   只填主机名（如 `http://kb.internal:8501`）时，按默认端点 `/api/mcp` 处理。
   填了路径就原样使用，不会再往后拼后缀。
2. **MCP 令牌**：粘贴令牌 → 点**保存**。保存后输入框立即清空，之后只显示「已配置」。
   从整段 MCP 配置里复制过来、连 `Bearer ` 前缀一起粘也没关系，保存时会自动去掉。
3. 打开**启用知识库**开关 → 点**测试连接**。

> **测试连接必须先保存。** 自检读的是磁盘上已加密的令牌，看不到输入框里刚敲的内容。

自检做三件事：握手 → 列工具 → **真调一次无参只读工具**。第三步不能省：很多服务端的 `tools/list` 根本不校验鉴权（不带令牌也照样返回全部工具），只做前两步会给出假阳性——界面显示「连接正常」，而 Agent 一调用就报「缺少有效的 API Token」。

自检结果会列出**当前令牌实际可用的工具**，并按角色映射判断读写权限。客户端**不提供**「允许写入」开关，权限由服务端令牌 scope 决定。

**三个条件缺一不可**（开关打开、地址已填、令牌已配）。缺任何一个，Agent 手里**完全没有** `kb_*` 工具——这是故意的：不这样做，没配令牌的用户会拿到一整套工具而每次调用都是 401，Agent 反复重试把整轮对话烧掉。

配好后重开会话生效。落地页的「公司知识库」chip 与 `/skill:knowledge-base` 也会同步出现。

### 常见报错对照

| 提示 | 原因 | 怎么办 |
| --- | --- | --- |
| 令牌无效或已吊销（401） | 令牌错、过期或被撤销 | 向管理员换一枚 |
| 令牌未通过服务端校验：… | 令牌不完整，或服务端不认这个令牌 | 重新复制完整令牌再保存 |
| 地址不对：… 上没有 MCP 端点（HTTP 404 / 405） | 路径填错（405 多半是前置 nginx：路径不存在且不允许 POST） | 核对端点路径，如 `/mcp` 还是 `/api/mcp` |
| 请先在 设置 → 知识库 中填写 MCP 令牌 | 只填了地址没存令牌 | 填令牌后点保存 |
| 系统密钥库不可用 | 钥匙串被锁或环境异常 | 解锁钥匙串后重试 |
| 已连接，但服务端未提供任何工具 | 令牌 scope 为空 | 让管理员给令牌加权限 |
| 无法连接：timeout | 网络不通 / 需要 VPN | 确认能访问内网 |

---

## 4. 自建方：服务端要满足的契约

想接入自己的知识库，只需提供一个符合下述契约的 **MCP Streamable HTTP** 服务。Cortex 不关心你底层用什么检索引擎。

### 4.1 端点与协议

| 项 | 值 |
| --- | --- |
| 路径 | 任意——由用户填写。只填主机名时才补默认的 `/api/mcp` |
| 传输 | MCP Streamable HTTP（POST JSON-RPC 2.0） |
| 协议版本 | `2025-06-18` |
| scheme | 只允许 `http` / `https`（其它 scheme 直接不注入） |
| 响应体 | 纯 JSON 或 SSE 帧（`data:` 行）皆可，客户端两种都认 |
| 超时 | 单次请求 15 秒；测试连接 10 秒 |

### 4.2 请求头

客户端发出的头：

```http
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer <token>
MCP-Protocol-Version: 2025-06-18      # 握手之后的请求
Mcp-Session-Id: <握手时服务端签发的>   # 仅当服务端签发了才带
```

> `Accept` 必须同时接受两种类型——这是 MCP Streamable HTTP 的要求。服务端若只认 `application/json` 亦可，但**不要**因为 `Accept` 含 `text/event-stream` 就回 4xx。

### 4.3 握手时序

```
1. POST initialize
     ← 响应头可选带 mcp-session-id
2. POST notifications/initialized     ← 服务端签发了 session id 时必发
3. POST tools/list / tools/call
```

第 2 步**不能省**（在有 session 的实现里）：不发它，后续请求会被拒并回「method ... is invalid during session initialization」。

无状态实现不签发 session id，此时客户端跳过第 2 步、后续也不带该头，其余流程一致。

客户端标识：`clientInfo = { name: "cortex-desktop", version: "1" }`。

### 4.4 鉴权与状态码

| 状态码 | 客户端行为 |
| --- | --- |
| `401` | 显示「令牌无效或已吊销」 |
| `404` / `405` | 显示「地址不对：<端点> 上没有 MCP 端点」并回显实际请求的地址 |
| 其它非 2xx | 显示「连接失败：HTTP <code>」 |

**令牌 scope 通过 `tools/list` 表达**：只读令牌就**不要返回** `kb_write_doc`。客户端把工具清单原样展示给用户，这是它判断权限的唯一渠道。

### 4.5 工具调用结果的形状

客户端优先读 `structuredContent`，读不到时回落到 `content` 的文本：

```json
{
  "structuredContent": { "...": "结构化结果" },
  "content": [{ "type": "text", "text": "给模型看的文本" }]
}
```

**建议声明 output schema 并返回 `structuredContent`**，字段名能直接对上、显示效果最好。没有也能用：客户端会把 `content` 文本当正文兜底（很多 MCP server 不声明 outputSchema，只认结构化输出会把正常读到的文档误报成失败）。

工具级错误（路径非法、文档不存在等）用 `isError` + `content`，**不要**用 JSON-RPC 协议错误：

```json
{ "isError": true, "content": [{ "type": "text", "text": "文档不存在" }] }
```

## 5. 工具集：不需要按我们的名字来

**工具名由你决定。** 客户端连上后跑一次 `tools/list`，把服务端**实际提供的方法**映射到五个语义角色，再把这份清单动态写进 Agent 的系统提示。你不需要为了接入而改名。

| 角色 | 用途 | 缺了会怎样 |
| --- | --- | --- |
| `search` | 检索 | Agent 无法主动查资料（内置 skill 会说「未接入」） |
| `read` | 读正文 | 会话里的引用无法展开原文，且不再生成 `kb://` 链接 |
| `list` | 列文档 | 只是少一个「知识库里都有什么」的入口 |
| `ask` | 服务端 RAG 直接给结论 | 少一条快路，不影响主链路 |
| `write` | 写入沉淀 | 设置页显示「只读接入」 |

### 5.1 映射规则

1. **精确名优先**：叫 `kb_search` / `kb_read_doc` / `kb_list_docs` / `kb_ask` / `kb_write_doc` 的直接命中。
2. **否则按关键词匹配**：
   - search ← `search` / `query` / `retrieve` / `find`
   - read ← `read` / `get_content` / `get_document` / `fetch_document` / `content`
   - list ← `list` / `browse` / `index`
   - ask ← `ask` / `answer` / `rag` / `qa`
   - write ← `write` / `upload` / `create_document` / `put_document` / `save`
3. **名字含这些词的一律排除**（避免周边工具被误认成主力）：
   `download`、`history_version`、`delete`、`remove`、`create_knowledge_base`、`directory`
4. 一个工具只归一个角色，先到先得。

映射结果在设置页点「测试连接」时可见：识别不出检索或读取工具会明确提示。

### 5.2 文档坐标与 `kb://` 引用

Agent 在回答里给出的可点击引用是 `kb://<a>/<b>`，其中 `<a>` `<b>` 是**你的读工具的前两个必需参数**（自动从 `inputSchema.required` 推断，排除 `offset` / `limit` / `around` 等分页参数）。

- 自家 kbserver：`kb://<sourceId>/<relPath>`
- 某企业 wiki：`kb://<knowledgeBaseId>/<documentPath>`

所以检索结果里**必须带上这两个坐标字段**，且能原样回传给读工具。参数声明成 `integer` / `number` 时客户端会自动把链接里的数字串转回数字。

`<a>` 是第一段，因此**它的值里不能有 `/`**；`<b>` 可以有。

推断不出坐标（读工具没有 schema）时回退到 `sourceId` / `relPath`。没有 read 角色时，系统提示会明确禁止 Agent 生成 `kb://` 链接——避免产出一堆点开就报错的死链接。

### 5.3 正文字段

读工具返回的正文，客户端按这个顺序找：`text` → `content` → `body` → `markdown`，都没有就用 `content[].text` 兜底。

其余字段同样支持别名：

| 用途 | 接受的字段名 |
| --- | --- |
| 文件名 | `fileName` / `documentName` / `name` |
| 总长度 | `totalRunes` / `totalChars` / `totalLength` |
| 还有后文 | `hasMore` |

## 6. 自检：不装客户端也能验

把 `KB` 与 `TOKEN` 换成你的值：

```bash
KB=http://kb.internal:8501
TOKEN=xxxxx

# 1) 握手（-i 看响应头里有没有 mcp-session-id）
curl -sSi -X POST "$KB/api/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cortex-desktop","version":"1"}}}'

# 2) 若上一步签发了 session id，先发这条通知（SID 换成实际值）
SID=<上一步返回的 mcp-session-id>
curl -sS -X POST "$KB/api/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" -H 'MCP-Protocol-Version: 2025-06-18' -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3) 列工具——这一步的输出应与 Cortex「测试连接」显示的清单一致
curl -sS -X POST "$KB/api/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" -H 'MCP-Protocol-Version: 2025-06-18' -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

三步都通、且工具清单里有能当「检索」和「读正文」用的工具（名字随你，见第 5 节的映射规则），就可以填进 Cortex 了。

---

## 相关代码

| 位置 | 职责 |
| --- | --- |
| `apps/desktop/src/main/capabilities/knowledge/inject.ts` | 三门控 + 注入配置构建（地址归一化、令牌解密） |
| `apps/desktop/src/main/capabilities/knowledge/client.ts` | 主进程自用的极简 MCP 客户端（握手 + 单次 tools/call） |
| `apps/desktop/src/main/ipc/knowledge.ts` | 令牌加密落盘、连通性自检、取文 |
| `packages/views/cortex-desktop/personal/settings/KnowledgeSettingsSection.tsx` | 设置界面 |
| `packages/views/cortex-desktop/personal/knowledge/` | `kb://` 引用 chip 与右栏正文预览 |
| `apps/desktop/src/main/capabilities/knowledge/tools.ts` | 能力探测、角色映射、注入 prompt 的能力块渲染 |
| `apps/desktop/resources/skills/knowledge-base/SKILL.md` | 内置 skill：检索策略与引用格式（不写死工具名） |
