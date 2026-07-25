---
title: "Cortex Research Engine M1 验收记录"
type: acceptance-log
date: 2026-07-25
status: m1-complete
spec: docs/superpowers/specs/2026-07-25-cortex-research-engine-development-spec.md
---

# CRE M1 验收记录

交付范围：spec 的 **U0 / U1 / U3 / U4 / U5 / U6 / U7 / U8**。
U9（跨消费者迁移）与 U10（Knowledge/Memory 写入）只在类型层与 SQLite schema 留位，无实现。

三条与 spec 的既定偏离（开工前确认）：Worker 用 TypeScript 而非 Rust；同步实现 `../server`
的 Go 搜索路由；协议承载改 `postMessage`（utilityProcess 不允许 pipe stdin，见 U0 findings S3）。

## 1. 验证命令与结果

全部在 2026-07-25 实跑，非 agent 自报。

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @cortex-work/core exec vitest run` | **3349 passed** |
| `pnpm --filter @cortex-work/views exec vitest run` | **1579 passed**（3 skipped，均为既有） |
| `pnpm --filter @cortex-work/desktop exec vitest run` | **2508 passed**（200 files） |
| `pnpm --filter @cortex-work/desktop test:sqlite` | **20 passed**（真 `node:sqlite`，ELECTRON_RUN_AS_NODE） |
| `pnpm typecheck` | 5/5 successful |
| `pnpm lint` | **0 errors**（仅既有 i18next / max-lines 警告） |
| `pnpm --filter @cortex-work/desktop build` | 通过 |
| `pnpm --filter @cortex-work/desktop build:worker` | 通过，`research-worker.js` 199 KB + `chunks/pdf-*.js` 875 KB |
| `pnpm --filter @cortex-work/desktop dist:dir` | 通过 |
| `node apps/desktop/scripts/verify-research-packaging.mjs` | **全部通过**（详见 §3） |
| `cd ../server && go build ./... && go vet ./...` | 干净 |
| `cd ../server && go test ./...` | 23 个包 ok，无 FAIL |

spec §20 里的三条 `cargo` 命令不适用（Worker 是 TypeScript，无 `tools/research-worker`）。

## 2. spec §19 验收标准逐条

### 19.1 功能

| # | 条目 | 状态 | 覆盖方式 |
| --- | --- | --- | --- |
| 1 | quick 从 Search Server 取候选 → 本地抓取 → 至少一条有效引用 | ✅ 自动化 | `main/research/e2e-single-round.test.ts`：假 SearchServer + 假 WorkerTransport 跑通 `create → run → get("full")`，断言终态 `completed` + 至少一条有效 `CitationRef` |
| 2 | standard 至少两轮并按 Coverage 生成补充查询 | ✅ 自动化 | `research-orchestrator.test.ts` 多轮用例：coverage `weak` → `search_more` → 第二轮 `sufficient` → `finish` |
| 3 | 取消 Search / Fetch / Browser / 模型后终态 `cancelled` | ✅ 自动化 | `research-orchestrator.test.ts` 三阶段取消各一例。取消兜底放在 `runOperation` 层（execute 与 abort 赛跑），不依赖被调用方尊重 signal |
| 4 | 任一阶段退出后重启 → `interrupted` 且可恢复 | ✅ 自动化 | `startup-recovery.test.ts`（五个非终态各一条 → 全部 `interrupted`）+ `startup-recovery` 在 `main/index.ts` 启动路径上真实接线 |
| 5 | Worker 被强杀后 main 可重启，已提交 evidence 不丢 | ✅ 自动化 | `worker/process-manager.test.ts`（崩溃上报 + pending 全 reject）+ `research-repository.sqlite.test.ts`（提交事务原子性） |
| 6 | 模型生成未知 `chunkId` 时被拒 | ✅ 自动化 | `core/research/citation.test.ts` + `report-generator.test.ts`（未知 id 删除 + 该段标 unsupported） |

### 19.2 安全

| # | 条目 | 状态 | 覆盖方式 |
| --- | --- | --- | --- |
| 1 | localhost / RFC1918 / link-local / IPv6 loopback / 十进制十六进制 IPv4 变体均被拒 | ✅ 自动化 | `core/research/url-safety.test.ts` 表驱动，覆盖 `127.0.0.1` / `0x7f000001` / `2130706433` / `0177.0.0.1` / `127.1` / `[::1]` / `::ffff:127.0.0.1` / `fe80::` / CGNAT 等全部变体 |
| 2 | 公网 URL 30x 跳私网被拒 | ✅ 自动化 | `worker/net/safe-request.test.ts`。实现上 redirect 循环内**每一跳**重跑 `checkUrlPolicy` + `resolveAndGuard`（已读代码确认，非仅测试名） |
| 3 | Browser 的导航 / 子资源 / fetch / WebSocket 拦截 | ⚠️ 部分 | **参数序列与 action policy 已自动化**（见下）；**子资源与 WebSocket 层面的实际拦截未验证**——需真 Chrome + 会发跨域子请求的测试页，无法在无窗口环境自动化。列入人工清单 |
| 4 | public_web 内容不获得 Memory / 本地文件 / 终端 / 发送 / 写工具 | ✅ 自动化 | `research-model-gateway.test.ts` 断言请求体不含 `tools` / `functions` / `tool_choice`；`gap-planner.test.ts` 对 prompt 做 inline snapshot，负向断言正文与本地路径不出现。Memory / 本地文件的正文过滤由 `report-generator.ts` 的 `canSendToCloudModel` 逐来源闸门保证（`report-generator.test.ts` 有 memory 来源被剔除、文档元数据缺失 fail-closed 两例）|
| 5 | ~~`local_only` 下无任何证据请求到达远程模型~~ → **选型失败时零出站** | ✅ 自动化 | **本条已随 KTD5 修订**：出站策略枚举已移除（理由见 spec KTD5 的修订说明），`local_only` 这个档位不再存在——「正文不出本机」现在由用户直接选一个 loopback 供应商达成，`isLocal` 如实反映。保留下来的等价性质是「前置选型失败时一个字节都不出站」：`research-model-gateway.test.ts` 断言 `fetchFn` 调用 **0 次**；`planner/llm-hooks.test.ts` 在真网关上验证装配后同样零出站 |
| 6 | Hosted Search 无 JWT/PAT → 401；非成员 → **404** | ✅ 真实链路实测 | 2026-07-25 对真实 backend + Postgres 实跑：无凭据 → `401`；用户 B 打用户 A 独占的 workspace → `404 {"error":"workspace not found"}`。**404 是刻意设计**（`internal/middleware/workspace.go` 对非成员统一回 404，避免探测 workspace 是否存在；403 只用于角色不足），`research_search_integration_test.go:47` 已有同样注释。故本条原文的「403」是 spec 措辞过时，非实现缺陷。客户端 `statusToCode` 把 404 归入 `http_error`，编排层无重试逻辑，不会重试风暴 |
| 7 | 打包产物不含共享 Search API Key | ✅ 自动化 | `verify-research-packaging.mjs` 第 3 组。`router.go` 侧亦无硬编码默认值：缺 `RESEARCH_SEARCH_HMAC_KEY` 时用进程内临时密钥并告警，生成失败则禁用搜索（fail closed） |

### 19.3 隐私

| # | 条目 | 状态 | 覆盖方式 |
| --- | --- | --- | --- |
| 1 | 查询全文不出现在 Go/Node 日志或 Redis key | ✅ 自动化 + 变异验证 | Go 侧 `cache_test.go` 的 `TestCacheKeyNeverContainsQueryText` / `TestAuditFieldsHasNoRawText`（**纯单测，不依赖 Redis，不会被 skip**）；已变异验证（给 CacheKey 追加原文后立刻变红）。Node 侧 `redact-research.test.ts` |
| 2 | renderer 的 summary 不含正文 / token / 模型凭据 | ✅ 自动化 | `research-repository.sqlite.test.ts` 用 tracing driver 断言 summary 路径**根本没查** `research_documents` / `document_chunks` / `research_reports`（只断言返回值证明不了这点）；`ResearchSessionList.test.tsx` 覆盖 UI 侧 |
| 3 | 未批准的本地文件 / Memory 不进远程模型请求 | ✅ 自动化 | `report-generator.test.ts` 的来源级出站过滤（逐 chunk 过 `canSendToCloudModel`） |
| 4 | 删除 Session 后无引用的 blob 可 GC | ✅ 自动化 | `blob-store.test.ts` + `research-repository.sqlite.test.ts`（`listReferencedContentHashes` → `gcOrphanBlobs`） |

### 19.4 性能基线

**全部未验证** —— 仓库无 benchmark 基础设施，且需真实 SearXNG 实例与真实网络。列入人工清单：
Search P95 ≤ 20s、10 个 HTML 本地抓取 P95 ≤ 60s、Worker 空闲 RSS ≤ 40 MiB、
Browser 并发默认 1 最多 2（**这条已在代码层由 `BrowserBudget` 强制并单测**）、
1000 文档的 list/get summary 不读 blob（**这条已由 §19.3.2 的 tracing driver 测试覆盖**）。

### 19.5 打包

| 条目 | 状态 |
| --- | --- |
| 携带匹配架构的 Research Worker | ✅ **TS Worker 跑 Electron 内嵌 Node，无架构相关产物，该要求自动满足** |
| Worker 可执行并通过 hello/doctor | ✅ 打包态实测（见 §3） |
| 复用的 agent-browser 路径在打包态可解析 | ✅ 打包态实测 |
| Worker / agent-browser / SQLite / blob 均在 asar 外的受控位置 | ✅ worker 与 pdf chunk 在 `app.asar.unpacked`；SQLite 与 blob 在 `~/.cortex-desktop/research/` |
| 不复用其他架构的二进制 | ✅ 同第一条，不适用 |

## 3. 打包态验证输出（`verify-research-packaging.mjs`）

```
产物: apps/desktop/dist/mac-arm64/Cortex.app

[1] Worker 产物
  ✓ research-worker.js 存在于 asar 外（asarUnpack 生效） — 199 KB
  ✓ pdfjs chunk 一并解包（否则运行期 dynamic import 会失败） — pdf-CspYGh-A.js
  ✓ worker 产物不 require 任何第三方包（只允许 node 内建） — 仅 node 内建

[2] agent-browser
  ✓ 二进制存在且可执行 — 10.4 MB

[3] 密钥泄漏
  ✓ 产物内无硬编码的 Search Server 凭据 — 未发现

[4] 打包态 fork（U0 spike S7 的最后一环）
  ✓ 从 app.asar.unpacked fork worker 并完成 hello/doctor 协议往返
    — hello + doctor 通过，pdf_available=true
```

`pdf_available=true` 是关键：它证明 bundle 进 worker 的 pdfjs 在**打包态**也能加载。

## 4. 人工验证清单（尚未执行）

按仓库规则，真实窗口 / renderer 自动点击 / 完整 GUI E2E 需用户明确授权后执行。以下留待人工：

1. **§19.2.3 的子资源与 WebSocket 拦截** —— 真 Chrome + 会发跨域子请求的测试页，
   验证 `--allowed-domains` 是否同时约束顶层导航之外的请求。
2. **§19.4 全部性能基线** —— 仍缺 benchmark 基础设施。已有的一手数据见 §7：
   单查询约 3.6s、双查询约 5.2s、三查询约 1.8s，均远好于 P95 ≤ 20s 的目标，
   但这不是按 P95 采样的正式基线。
3. ~~**§19.2.6 的 401/403**~~ —— **已执行**，见 §19.2 第 6 行与 §7。
4. ~~**SearXNG 真实链路的结果质量与 engine 可用性**~~ —— **已执行**，见 §7。
5. **三平台打包后的实际启动与 doctor** —— 当前只验了 mac-arm64；mac-x64 与 win-x64 待验。
6. **Deep Research UI 的真实交互** —— 创建 / 运行 / 暂停 / 取消 / 恢复 / 导出的窗口内手测。

## 5. 已知限制与后续项

| # | 内容 | 影响 |
| --- | --- | --- |
| 1 | **正文抽取是自研启发式**（标签剔除 + `<article>/<main>` 优先 + 文本密度），质量低于 readability | 抓取质量。刻意不引第三方依赖（打包 / 许可 / 审计成本），已记入 `docs/lessons.md` 待后续替换 |
| 2 | ~~**`ModelDataPolicy` 重启后读不回**~~ —— **已修复**（2026-07-25）。仓储新增窄方法 `getSessionModelDataPolicy`，`research-service` 改为「内存缓存 → 仓储 → fail-closed」三级。 | 原判断「最坏结果只是 LLM 降级为确定性摘要」**低估了实际影响**，真实踩到的链条是：用户选 `metadata_only` → 重启后被当成 `local_only` → 选型只在 loopback provider 里挑 → `defaultModel` 不在其列表 → 回落 `models[0]`，而那恰好是个 reranker（`bge-reranker-v2-m3`）→ 18ms 回 HTTP 400 → Planner 与报告**双双静默降级**。用户看到的是「计划只剩一行原始目标、报告像证据堆砌」，日志里却只有一句 `call_failed`。见 §8 |
| 3 | **`userScope` 固定为 `"local"`** | 单账号本地应用下正确。多账号落地后改成账号 id，旧数据会因 scope 不同自然停止跨账号复用 |
| 4 | **Worker 崩溃后惰性重拉**，不自动重启 | 避免重启风暴；下次 `ensure()` 重新 fork |
| 5 | **`slides` / `writing` / `memory` 三个 consumer 开关在 UI 上禁用**并标「即将支持」 | U9/U10 范围，M1 只接了 chat 与 deep_research |
| 6 | **跨 Session 复用的文档行归属原 Session**，原 Session 删除则该行随级联消失 | M1 可接受。若要让复用文档独立于来源 Session 生命周期，需新增迁移把 `research_documents` 提为 Session 无关表 |
| 7 | **`agent-browser` 的 action policy 是 fail-open 的** | 已用探针自检 fail closed 对冲（见 U0 findings S4a），且用真实二进制验证过解析逻辑匹配实际输出 |
| 8 | **`ipc/types.ts` 已 1199 行**（上限 1200） | 后续任何新增都必须另开文件；`ResearchEngineMainSettings` 已拆到 `ipc/types-research.ts` |

## 6. spec §22「完成定义」核对

| 条目 | 状态 |
| --- | --- |
| Search Server / Electron main / Worker 的真实链路通过 | ⚠️ 三方各自通过且契约已用真实数据往返验证（Go 序列化 → TS zod 解析）；**端到端串真实 SearXNG 尚未跑**（需自建实例） |
| 至少 chat quick 与 Deep Research 两个 Consumer 共用同一 Evidence/Citation 能力 | ✅ 两者走同一 Facade / 编排 / 引用校验 |
| 公共/私有 Trust Zone、模型出站、Browser SSRF 有自动化测试 | ✅ |
| 所有非终态可恢复 | ✅ |
| 引用不能由模型伪造 | ✅（`validateCitations` + 变异验证） |
| 代码落在真实 Desktop/Server 仓边界 | ✅ 未在 cortex-work 内重建 `server/` |
| 现有 Agent Browser / Slides / Writing Retrieval / Memory 有明确复用或迁移路径 | ⚠️ Agent Browser 已复用；Writing Retrieval 的词法层已上移 `core/retrieval/lexical.ts` 并零行为变更；**Slides 与 Memory 属 U9/U10，本轮只留位** |
| 文档中的验收命令与 CI 均已执行并记录 | ⚠️ 本地全部执行并记录于此；**CI 未配置**（该仓库无 `.github/`） |

## 7. 真实链路本地验证（2026-07-25 追加）

第一次把 **SearXNG → Go backend → HTTP 端点** 三段真实串起来跑通，补上了 §6
「端到端串真实 SearXNG 尚未跑」那一条。全部命令实跑，非推断。

### 7.1 结论

| 项 | 结果 |
| --- | --- |
| `POST /api/workspaces/{id}/research/search/batch` 真实链路 | ✅ 200，返回真实网页结果 |
| JWT 与 PAT 两种凭据 | ✅ 均可用 |
| 无凭据 | ✅ 401 |
| 非成员 workspace | ✅ 404（刻意，见 §19.2 第 6 行） |
| Redis 结果缓存 | ✅ 生效（二次同查询 `cache_hit=true`、`duration_ms=0`） |
| 局部失败降级 | ✅ 多数引擎 CAPTCHA / 403 时仍回 200 + 可用结果 |
| 全部 Provider 失败 | ✅ 503 `search_unavailable` |

实测样例（三条并发查询）：

```
stats: provider_count=1 raw_result_count=78 returned_result_count=16
       cache_hit=false duration_ms=5212
q1 items=8 engines=[bing,dogpile,mwmbl,searchmysite,seznam] errors=[]
q2 items=8 engines=[bing,dogpile,mwmbl,seznam]              errors=[]
```

### 7.2 环境上的三个坑（下次验证直接照做，别重新踩）

1. **容器没有出口网络。** SearXNG 容器直连任何引擎都超时——宿主机的全局代理
   （Surge 增强模式）不接管 Docker 流量。解法是在宿主机跑一个绑 `0.0.0.0` 的
   HTTP 正向代理（支持 CONNECT），容器侧在 `settings.yml` 的 `outgoing.proxies`
   指向 `http://host.docker.internal:<port>`。
   ⚠️ **不要**改成「中继到 Surge 的 SOCKS 端口」：那会形成双重代理，实测 TLS
   握手阶段被拆链（`SSL_ERROR_SYSCALL`）。让代理进程自己发起出站连接才对。

2. **宿主机的 `127.0.0.1:8080` 到不了 backend。** 返回带 `Proxy-Connection` 头的
   400，且 backend 日志里根本看不到该请求——被本地代理层截走了。`18080` 也不行
   （`gorelay-a` 占着 `*:18080`）。用 compose override 追加一个 `127.0.0.1:28080`
   映射即可（ports 是追加语义，原映射不受影响）。
   判据：容器内 `wget 127.0.0.1:8080/health` 正常 + 宿主机对照端口 8888 正常
   → 问题一定在宿主机侧，不在 backend。

3. **两套 compose 不共享网络。** backend 要用服务名访问 SearXNG，需要
   `docker network connect --alias searxng cortex-server_default cortex-research-search-searxng-1`，
   然后 `SEARXNG_BASE_URL=http://searxng:8080`。
   ⚠️ 对 searxng 跑 `--force-recreate` 会**丢掉这个手工接入的网络**，必须重新
   connect——否则表现成 `503 search_unavailable`，看着像搜索质量问题，其实是网络断了。

### 7.3 引擎可用性实测（当前出口）

逐个引擎测下来，能用的很少，且**默认配置里点名启用的四个全军覆没**：

| 引擎 | 状态 |
| --- | --- |
| `duckduckgo` | ❌ 直连即 timeout，经代理同样；域名在本网络不可达 |
| `brave` / `google cse` | ❌ 持续 429 |
| `startpage` / `qwant` | ❌ CAPTCHA |
| `yep` | ❌ 403 |
| `mojeek` | ⚠️ 结果质量最好，但**一次 batch 并发两条查询就 403 并熔断 180s** |
| `bing` / `mwmbl` / `wiby` / `dogpile` / `seznam` / `searchmysite` | ✅ 可用 |
| `github` / `arxiv` | ✅ 可用（各自领域） |

**这条对产品有实际影响**：`docker/research-search/searxng/settings.yml` 里显式
`disabled: false` 的四个引擎中，只有 `github` / `arxiv` 真能用，`duckduckgo` 与
`brave` 在这个出口下是纯粹的延迟负担——每次搜索白等一轮超时/熔断，把可用引擎的
延迟也拖高。是否改仓库默认值取决于目标部署环境的出口，本次只在本地 override 里
关掉，未动仓库配置。

### 7.4 尚未验证

本轮只打通并验证了**服务端链路**。Desktop 端（`research-service` → Worker → 抓取 →
引用校验 → 报告生成）的真实窗口交互仍在 §4 第 6 条，未执行。

## 8. 首次真实端到端运行的复盘（2026-07-25 追加）

第一次跑完整链路（SearXNG → 候选 → 抓取 → 报告）。表面症状是「全部抓取失败、报告像乱码」，
实际拆开是**三个互不相干的问题**，其中只有一个是真缺陷。

### 8.1 抓取并没有全失败

15 个候选，**成功 9 个**，产出 104 个 chunk。UI 的「未能采信的来源（6）」只列失败项、
不展示成功项，所以看起来像全挂了。这是**表达问题不是功能问题**，但误导性很强 ——
排查时第一反应会去查抓取层，而那里没有问题。

失败的 6 个是真的抓不到，且与实现无关：

| 域名 | 状态 | 说明 |
| --- | --- | --- |
| `zhuanlan.zhihu.com` | 403 | 硬反爬，带不带浏览器 UA 都拒 |
| `www.oracle.com` | 403 | 同上（实测**带** UA 反而 403，不带 UA 200，但换页面不稳定） |
| `adg.csdn.net` | 404 | 内容农场镜像站，URL 本身是死链 |

**验证过「加 User-Agent 能否救回」，结论是不能** —— 用 node:https 复现 worker 的真实条件
（调用点确实一个 header 都没传），带浏览器 UA 与不带的状态码完全一致。所以**不要**为此
去给抓取层加 UA，那是无效改动。

另有几篇抓到了但正文近乎为空（`datawhalechina.github.io` 9 字符、YouTube 17 字符、
Medium 71 字符）—— 自研启发式抽取对 SPA / JS 渲染页面基本失效，属已知限制第 1 条。

### 8.2 SearXNG 的满屏报错是探测配置的噪音

`docker/research-search/searxng/settings.yml` 当前是一份带「临时探测批」的配置，
显式打开了十几个引擎。其中 `duckduckgo` / `qwant` / `presearch` / `yacy` / `yahoo` /
`seznam` 在本网络出口下全部超时或 CAPTCHA，于是日志里刷屏。

**不影响功能**（局部失败会降级，能用的引擎照常返回结果），但每轮搜索要为死引擎白等一轮超时。
探测结论见 §7.3，验证完应把探测批删掉只留可用的那几个。

### 8.3 真正的缺陷：策略读不回 → 选中 reranker 当 chat 模型 → 静默降级

这才是「报告像证据堆砌」的原因，与抓取无关。完整链条：

1. Session 建于 14:36，`model_data_policy = metadata_only`（DB 里确实是这个值）；
2. 应用重启。仓储不回传该字段，`research-service` 的内存缓存丢失 → fail-closed 成 `local_only`；
3. `local_only` 下选型只在 loopback provider 里挑 → 选中本机 `http://127.0.0.1:8000/v1`；
4. `defaultModel`（`deepseek-v4-pro`）不在该 provider 的模型列表里 → **回落 `models[0]`**，
   而它恰好是 `bge-reranker-v2-m3` —— 一个 reranker；
5. 服务端 18ms 回 `HTTP 400: Model 'bge-reranker-v2-m3' is not an LLM / chat model`；
6. Planner 降级为种子计划（所以「研究计划」只剩一行原始目标），
   报告降级为确定性证据摘要（所以读起来是片段拼贴）。

**为什么排查这么久**：三处降级日志都只记 `result.code`，把 `message` 和选型结果全丢了。
日志里就一句 `call_failed`，既看不出选了哪个 provider、也看不出选了什么模型。

**已修**：
- 仓储新增 `getSessionModelDataPolicy`（只 SELECT 一列），`research-service` 改为
  「内存缓存 → 仓储 → fail-closed」三级，重启后不再误判策略；
- `ModelCallResult` 的失败分支带上 `providerId` / `model`（配置不是用户数据，无隐私代价），
  三处降级日志改为记录 `{code, message, provider, model}`。

**未修、留作后续**：`selectResearchModel` 回落 `models[0]` 时**不做任何能力校验**，
provider 的模型列表里混有 reranker / embedding / OCR / TTS 时会选中它们。
可靠的能力判定需要 provider 侧的元数据，靠 id 猜是脆的；当前先靠 §8.3 的日志改进
让它在一次调用内就能被认出来。

## 9. Browser 兜底的三个缺陷（2026-07-25 追加）

起因是「优化知乎抓取」。结论分两半：**知乎抓不了且是设计取舍**；但顺着查下去发现
Browser 兜底整条路径此前**从未真正工作过**，已修。

### 9.1 知乎：不修，且不建议修

`zhuanlan.zhihu.com` 对纯 HTTP 返回 403。实测下列条件**全部 403**（用 node:https 复现
worker 的真实栈，非 curl —— curl 默认会带 UA，会得出错误结论）：
裸请求 / 仅 UA / UA+完整 Accept 三件套 / UA+Referer+Sec-Fetch / Googlebot UA。

**所以不要给抓取层加 User-Agent，那是无效改动。**

改用真 Chrome（见 9.2 的修复）后能拿到响应，但内容是反爬页：
`{"error":{"message":"您当前请求存在异常，暂时限制本次访问...","code":40362}}`。
知乎要求 cookie / 登录态，而 Research Browser 按 KTD7 刻意**永不复用用户已登录的 profile**
（`--restore-save never`，且 `--profile` / `--state` / `--restore` 在
`FORBIDDEN_AGENT_BROWSER_FLAGS` 里）。要抓知乎就得破这条红线，不值得。

**遗留问题**：这类反爬页会以「抓取成功」的姿态进入证据库（126 字的 JSON 错误体），
比抓取失败更糟——它会被当成正文送进报告。当前只有 `text.length === 0` 一道闸。
通用地识别反爬页是启发式的，未做。

### 9.2 三个叠加缺陷（已修）

| # | 缺陷 | 后果 |
| --- | --- | --- |
| 1 | `runtime.ts` 未注入 `agentBrowserBinary` | worker 在 `if (!binary) return null` 直接放弃，**整条兜底是死代码** |
| 2 | action policy 写子命令名 `open`，而规范名是 `navigate` | 导航永远被 deny，适配器只能退用 `read <url>` —— 那条路走 agent-browser 自带 HTTP 客户端，**不启动 Chrome** |
| 3 | 导航后未等渲染 | `open` 返回 ≠ 渲染完，SPA 页 5 次里 2 次读到空壳 |

三者叠加的净效果：Browser 兜底对它存在的**全部三个触发场景**（403 / 429 / 空正文）都无效。

**实测收益**（`datawhalechina.github.io/happy-llm`，真二进制）：

```
read <url>（修复前的兜底路径）  → source: html-fallback   正文 0 字
open + read（修复缺陷 2）       → source: active-tab-html 正文 3188 字（但 5 次里 2 次只有 11 字）
open + wait networkidle + read → 5/5 稳定 3188 字
```

YouTube 页同样从 17 字提升到 545 字。

修复：
- `runtime.ts` 接上 `agentBrowserBinary`（走公用的 `resolveAgentBrowserBinary`，每次现取
  而不是启动时缓存 —— dev 态 node_modules 可能晚于应用就绪）；
- `READ_ONLY_ALLOWED_ACTIONS` 补 `navigate` 与 `waitforloadstate`（保留子命令名以兼容版本差异）；
- 适配器序列改为 `eval(探针) → open → wait --load networkidle → read → close`，
  导航失败即返回、不再 read（否则会把上一页的残留内容当成本 URL 的正文写进证据库）。

**新增 `runtime-wiring.test.ts`**：对装配点做结构断言。缺陷 1 之所以能存在，正是因为
`ResearchService` 的可选依赖漏传既不报错也不会让任何单测变红。详见 `docs/lessons.md`。

## 10. 反爬站点的服务端抓取（2026-07-25 追加）

§9.1 结论「知乎抓不了」**已被推翻并实现**。当时的判断错在方法：用了一个自己编的 URL
（`p/677608727`，实际不存在）去测，知乎对不存在的文章也回 403 + 反爬挑战，于是被读成
「所有专栏页都被拦」。用**研究引擎真实失败过的三条 URL** 复测，结论完全相反。

### 10.1 实测依据

| 方式 | `p/1919046969076195976` | `p/7046080918` | `p/1989728299547639935` |
| --- | --- | --- | --- |
| worker 纯 HTTP | 403 | 403 | 403 |
| agent-browser（真 Chrome） | 40362 反爬页 | 同 | 同 |
| **Camoufox（scrapling StealthyFetcher）** | **200 / 98680 字** | **200 / 9000 字** | **200 / 4065 字** |

专栏页不是登录墙，是 `zse-ck/v4` JS 指纹挑战——Camoufox（C++ 层打过反指纹补丁的 Firefox）
正面击穿。首页与热榜确实跳 `/signin`（那是登录墙，仍抓不了），当时正是它坐实了错误判断。

单次稳态耗时 **5.0 / 4.9 / 5.2 秒**，比 agent-browser 起 Chrome 还快。

### 10.2 架构：抓取在服务端，凭据不出 main

```
worker 本地抓取 → 403/429
  ↓  main 判定域名命中 STEALTH_FETCH_DOMAINS
main → backend POST /api/workspaces/{id}/research/fetch   （PAT 鉴权 + SSRF 判定）
  ↓
research-fetch sidecar（Python + Camoufox）→ HTML
  ↓
main 把 HTML 经 fetch_prepare 的 prefetched 交回 worker → 走既有抽取/分块/引用管线
```

三条设计约束，改动前必读：

1. **Camoufox 不进 Electron**：约 150MB × 三平台、要过 macOS 公证、违反
   `verify-research-packaging.mjs` 的「worker 产物零第三方依赖」、并会成为第二个不受
   action policy 约束的浏览器（架空 KTD7）。服务端则只是多一个容器。
2. **PAT 绝不进 worker**：worker 解析的是不可信 HTML，一个解析漏洞就会升级成凭据泄漏。
   所以抓取留在 main、抽取留在 worker，HTML 经 `prefetched` 传递。
3. **必须有域名白名单**（`core/research/stealth-domains.ts`）：服务端每次起一个 Camoufox
   （5s、并发上限 2），且抓取 URL 会离开本机。不能所有 403 都无条件甩过去。
   后缀匹配**要求点边界**——`evilzhihu.com` 不得命中 `zhihu.com`，否则等于让任意域名
   挤进「可以让服务器去访问」的白名单。

### 10.3 SSRF 是三道闸

这个端点的语义天然危险：「你给我 URL，我这台服务器去访问它」。少了判定，任何持 PAT 的成员
都能让 backend 去打内网（Redis / Postgres / `169.254.169.254` / K8s API）。

| 层 | 位置 | 防的是 |
| --- | --- | --- |
| Go | `internal/service/researchfetch/urlguard.go` | 外部调用方（**转发之前**判定） |
| Python | `docker/research-fetch/ssrf.py` | 有人绕过 backend 直接够到 sidecar |
| TS | `core/research/url-safety.ts` | 本地抓取路径 |

三处拒绝集合一致，测试用例共用同一份清单。真机实测（PAT 鉴权链路）：
`127.0.0.1` / `169.254.169.254` / `10.0.0.1` / `0x7f000001` / `file://` 全部
`400 blocked_by_policy`，无凭据 `401`，知乎 `200 / 428687 字节`。

**过程中发现的真实弱点**：`0x7f000001` / `2130706433` / `127.1` 在 Python 侧原本是靠
系统解析器**碰巧**拦住的——`ipaddress.ip_address` 对它们抛异常 → 落到 DNS → glibc/macOS
恰好解成 127.0.0.1。Go 侧用替身解析器跑同一批用例时暴露了这点。两端都补了显式的
inet_aton 归一化，不再依赖解析器行为。

### 10.4 fake-IP DNS 环境的逃生阀

Surge / Clash 的 fake-IP 模式把**所有域名**解析到 `198.18.0.0/15`（判为私网），严格判定会
拦下一切域名。`RESEARCH_FETCH_ALLOW_CIDRS` 显式放行，三条约束由测试守着：默认空、
只放行列出的段、**loopback / 链路本地 / 元数据地址无条件拒绝**（哪怕配 `0.0.0.0/0`）。
启动时打 WARNING。生产部署不应设置。

### 10.5 验收命令

| 命令 | 结果 |
| --- | --- |
| `cd ../server && go build ./... && go vet ./...` | 干净 |
| `cd ../server && go test ./...` | 25 包 ok，无 FAIL |
| `cd ../server/docker/research-fetch && pytest -q` | **52 passed** |
| `pnpm test` | core **3366** / desktop **2566** / views 1598 / ui 33 |
| `pnpm --filter @cortex-work/desktop test:sqlite` | 20 passed |
| `pnpm typecheck` | 5/5 |
| `pnpm lint` | 0 errors |
| `pnpm --filter @cortex-work/desktop build:worker` | 通过 |

### 10.6 未验证

- **sidecar 镜像未经 `docker build`**：Docker Hub 拉 `python:3.12-slim` 在本网络下超时，
  需要配 registry mirror。Dockerfile 已写好但只在宿主 venv 里验证了逻辑。
- **端到端窗口内手测**：服务端链路已真机验证（见 §10.3），但「桌面端发起研究 → 知乎候选
  被 stealth 救回 → 出现在报告引用里」这条完整路径尚未在窗口里点过。

## 11. 容器化与端到端验证（2026-07-25 追加）

§10.6 的两条未验项已完成。

### 11.1 镜像构建

Docker Hub 直连超时，用国内 mirror 取基础镜像再本地打标（**不改 daemon 配置**）：

```bash
docker pull docker.m.daocloud.io/library/python:3.12-slim
docker tag docker.m.daocloud.io/library/python:3.12-slim python:3.12-slim
docker compose -f docker/research-fetch/docker-compose.yml build   # → 732MB
```

### 11.2 端到端：stealth 真的救回了候选

用真实 SearchServer 搜「LLM agent 原理 深入浅出」，对返回的候选先试纯 HTTP（复现 worker
的本地抓取），失败的再走 stealth：

```
搜索: HTTP 200 | 10 个候选，其中知乎 2 个
  ✓ zhuanlan.zhihu.com 本地 403 → stealth 救回 895257 字节
  ✓ zhuanlan.zhihu.com 本地 403 → stealth 救回 706981 字节
本地成功 6 | stealth 救回 2 | 仍失败 0
```

全容器链路（backend 容器 → sidecar 容器 → Camoufox）：知乎 `200 / 428361 字节`，
SSRF 闸对 `127.0.0.1` / `169.254.169.254` / `10.0.0.1` 全部 `blocked_by_policy`。

### 11.3 踩到的坑：逃生阀要两边都设

backend 与 sidecar **各判一次 SSRF**，所以 `RESEARCH_FETCH_ALLOW_CIDRS` 两边都要有。
只在 `.env` 里设（backend 拿到了）、sidecar 的 compose 漏了透传，链路照样
`blocked_by_policy` —— 而错误码完全一样，看不出是哪一层拦的。已在 compose 注释里写明。

同样要记住：**对 sidecar 容器 `up -d` 重建后必须重新 `docker network connect`**，
否则 backend 解析不到 `research-fetch`（research-search 踩过同一个坑，见 §7.2 第 3 条）。

## 12. 报告输出预算（2026-07-25 追加）

用户反馈「报告内容看起来太少了」。查下去是两个独立问题：

### 12.1 输入按模式分档，输出却是固定值

`maxEvidenceCharsToModel` 是 quick 20k / standard 60k / deep 120k 字符，而
`REPORT_MAX_TOKENS` 固定 3000。**deep 模式读了 6 倍的材料，写出同样长度的报告** ——
用户看到的就是一份覆盖不全的摘要。

已改为同向缩放：

| | 输出 token | 每节证据条数 |
| --- | --- | --- |
| quick | 4,000 | 8 |
| standard | 8,000 | 16 |
| deep | 14,000 | 28 |

**两个旋钮必须一起调**：只放大输出预算，模型手上仍只有 8 条摘录，让它写 9000 字只会得到
注水——「报告变长」会变成幻觉而不是信息量增加。有测试钉住「deep 送进 prompt 的 chunk 数
必须多于 quick」。

### 12.2 `output.maxWords` 从来没人读

它在 `core/research/types.ts` 与 `consumer.ts` 的预设里都存在（report 预设写的是
**3000 words**），但报告生成器从不消费它——用户/预设指定的长度被静默忽略，
一直用那个固定的 3000 **token**（中文约 2000 字，正好是「太少」的观感来源）。

已接通，链路是：`session.output_json` → 仓储 `getSession` 映射进
`ResearchSessionView.output` → 编排层报告阶段 → `resolveReportMaxTokens`。
优先用 `maxWords × 1.5`（中文 1 字 ≈ 1 token，余量给 markdown 结构与 `[^chunkId]` 标记），
并夹在 32k 硬上限内（一个手滑多打几个 0 的 maxWords 不该烧穿单次调用配额）。

**顺带补上的能力**：`ResearchSessionView` 之前不带 `output`，sqlite 仓储虽然 `SELECT *`
但没映射该列。现在在 summary 层级就解出来——它只是一小段 JSON（格式/字数/是否强制引用），
不涉及正文，不违反「summary 路径不读正文」的隐私红线。解析失败只丢字段、不让整次
getSession 失败。

### 12.3 验收

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | core **3366** / desktop **2570** / views 1598 / ui 33 |
| `pnpm --filter @cortex-work/desktop test:sqlite` | 20 passed |
| `pnpm typecheck` | 5/5 |
| `pnpm lint` | 0 errors |
| `cd ../server && go build ./... && go vet ./...` | 干净 |

## 13. 终态会话的「重跑」（2026-07-25 追加）

用户反馈：「窗口里原来的任务已完成，无法继续跑了」。

### 13.1 为什么是克隆，不是就地重置

`session-status.ts` 的转移表把三个终态（completed / cancelled / failed）设成**无出口**，
并写明了理由：

> 终态：不可再转出任何状态。想「重跑」只能新建 Session，
> 这样报告与证据的因果链才不会被就地改写。

就地重置（退回 created + 擦掉 rounds/documents/report）会拆掉这条不变量：旧报告引用的
证据凭空消失，而那份报告可能**已经被导出或在别处引用过**。所以实现成克隆：

- `ResearchService.rerun(sessionId)` → 用同一批参数 `create` 一个新会话，返回新 summary；
- 旧会话连同它的报告原样保留，两次结果可以对照（这次恰好有用——预算改前改后能直接比）。

参数**逐项继承**：consumer / objective / mode / sourceScopes / modelDataPolicy /
output / budget。任一项悄悄取默认值，「重跑」就变成了「跑了个不一样的东西」，
而用户完全看不出来。`sourceScopes` 缺失（旧数据）时才退回 `public_web`——它是最小权限的那档。

### 13.2 顺带补上的读取能力

`ResearchSessionView` 之前不带 `output` 与 `sourceScopes`，sqlite 仓储虽然 `SELECT *`
但没映射这两列。重跑需要它们，已在 summary 层级解出（都是小段 JSON，不涉及正文，
不违反「summary 路径不读正文」的隐私红线）。解析失败只丢字段，不让整次 getSession 失败。

### 13.3 接线

`core` Facade → `research:rerun` IPC → preload → `views` 桥镜像 → `ResearchRunView` 的
「重跑」按钮（`canRerunSession` = 终态才可用）→ `ResearchWorkspace` 的 `onRerun`。

新会话由**宿主**接管（复用 onCreated 的落位逻辑：插列表 + 选中 + 清错）。宿主没接管时
按钮禁用——否则用户点完「什么都没发生」，后台却已经建了一个没人选中的孤儿会话。
有测试守着这条。

### 13.4 验收

| 命令 | 结果 |
| --- | --- |
| `pnpm turbo run test --force` | core **3366** / desktop **2575** / views 1603 / ui 33 |
| `pnpm turbo run typecheck --force` | 5/5（0 cached） |
| `pnpm --filter @cortex-work/desktop test:sqlite` | 20 passed |
| `pnpm lint` | 0 errors |
