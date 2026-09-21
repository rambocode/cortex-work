# 团队知识库（WeKnora 并入）规格

日期：2026-08-27　状态：已达成共识，待实施计划

## 目标

- 把 [WeKnora](/Users/mike/source/ai/WeKnora)（v0.7.2）**全功能**并入 cortex，作为团队工作区一级入口「知识库」。
- 「项目管理」（`../cortex-scrum`）本期只留入口（「即将上线」空态）。
- 知识库的 LLM 用 WeKnora 自己的模型设置，**不复用**个人设置区的 LLM（密钥留在服务器侧）。
- 个人工作区旧「公司知识库」（MCP → `../../knowledge-base-system`）本期不动；切到 WeKnora MCP 记为下一期。

## 后端（`../server`）

1. **代码引入**：`git subtree` 拉到 `../server/weknora/`，保留独立 `go.mod`，仓库根加 `go.work`。上游用 `git subtree pull` 继续同步。**WeKnora 源码零改动**。
2. **进程**：两个二进制 `cortex-server` + `weknora`。共用一个 Postgres 实例（镜像换成带 pgvector）、**独立 database**；Redis 共用；`docreader` 作 sidecar 容器。默认只起 `weknora-app` / `weknora-frontend` / `docreader`，其余可选服务（sandbox / minio / qdrant / milvus / searxng / dex / langfuse…）走 compose profile。
3. **对外地址**：WeKnora 用独立主机名或端口（前端把 `/api/v1` 与路由 base `/` 写死，不挂子路径）。部署侧 nginx 去掉主页面的 `X-Frame-Options`（供 Web 端 iframe）。
4. **SSO**：cortex-server 实现最小 OIDC IdP（discovery / authorize / token / userinfo / JWKS），WeKnora 走它现成的 OIDC 登录（`OIDC_AUTH_*`）。
5. **身份真源 = cortex**。映射：cortex 工作区 = WeKnora tenant + 1 个默认 workspace；squad 不映射。
6. **影子账号预置**：`authorize` 放行前，用 WeKnora 平台 API Key 确保 tenant 存在、该邮箱在 tenant 内存在。首次建号初始角色：`owner→Owner`、`admin→Admin`、`member→Viewer`，**只在建号那一刻赋一次**，之后角色全由 WeKnora 成员页管理，cortex 不再同步角色。
7. **移除同步**：cortex 移除成员 → 平台 API 把他移出对应 tenant（吊销会话与该 tenant 下 API Key）。单向、只同步移除。
8. **新端点**：
   - `GET /api/kb/config` → WeKnora 外部地址；未配置返回空，前端显示「未部署」空态。
   - `POST /api/kb/ticket` → 60 秒一次性票，绑定当前用户 + `wsId`。
   - `GET /api/kb/sso-start?ticket=` → 引导页：验票、把票种成本域 Cookie、跳进 WeKnora OIDC 流程；`authorize` 凭 Cookie 免交互放行。
9. 默认项：cortex 工作区删除 → tenant **停用**不删数据；影子账号密码随机不下发。

## 前端（`cortex-work`）

10. `core/store/ui.ts` 的 `Section` 增加 `"knowledge"`、`"scrum"`；`Sidebar.tsx` 顶部「用量」后加「知识库」「项目管理」。
11. 「知识库」整页占内容区：桌面端 `<webview>`（新建 `team-kb` 分区，复用 `main/browser/webviewGuards.ts` 闸门模式）；Web 端 iframe。进入即自动登录（走 8 的引导页），用户看不到 WeKnora 登录页；切换 cortex 工作区重走引导页。
12. 「项目管理」显示「即将上线」空态。
13. 同步更新 `docs/module-map.md`（团队工作区新增两行）。

## 不做

- 不改 WeKnora 源码；不映射 squad；不同步角色；不做 LLM 密钥同步；不动个人「公司知识库」。
