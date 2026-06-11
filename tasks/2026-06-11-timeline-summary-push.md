# 时间线日报增强：模型可配置 + 日历美化 + 复制/推送

> 状态：已完成（2026-06-11）。承接 tasks/2026-06-11-project-timeline.md。
> 决策：自定义模型走 OpenAI 兼容接口；邮件走 SMTP（nodemailer）；webhook/SMTP/LLM 请求都在主进程发（CORS + 密钥安全）；钉钉支持加签。

## 需求

1. 日报生成模型可在设置中选择：现有集成 Agent（claude/codex + 型号）或自定义 OpenAI 兼容端点（本地大模型）。
2. 日历视图美化。
3. 日报一键复制；推送到企业微信机器人 / 钉钉机器人 / 邮件，渠道在设置中配置。

## 设计

### 设置数据（持久化进 personal-workspace.json）

```ts
interface TimelineSettings {
  summaryModel:
    | { kind: "agent"; agent: AgentKind; model?: string }
    | { kind: "openai"; baseUrl: string; apiKey?: string; model: string };
  push: {
    wecom?: { enabled: boolean; webhookUrl: string };
    dingtalk?: { enabled: boolean; webhookUrl: string; secret?: string };
    email?: { enabled: boolean; smtpHost: string; smtpPort: number; secure: boolean;
              user: string; pass: string; from: string; to: string };
  };
}
```

### IPC（主进程）

- `llm:openaiComplete` — POST {baseUrl}/chat/completions，返回首条 content。
- `push:report` — 按 target.kind 分发：企微 markdown / 钉钉 text（可选 HMAC 加签）/ SMTP 邮件。

### UI

- 设置对话框新增「时间线」tab：模型选择 + 三个推送渠道配置。
- 日报卡片底部操作行：复制（始终显示）+ 已启用渠道的推送按钮，结果 toast。
- 日历重绘：月度汇总条、热力格重设计、今天徽标、周末着色、hover 提升。

## 实施清单

- [x] P1 core：TimelineSettings 类型 + store/持久化 + `buildDailyReportText`/`enabledPushTargets` + 生成走配置模型（含测试）
- [x] P2 desktop：`llm:openaiComplete` / `push:report` IPC + nodemailer 依赖 + preload 镜像；纯函数拆到 `push-sign.ts` 便于单测
- [x] P3 views：设置「时间线」tab（模型 + 三渠道表单）+ 天头部操作行（生成/复制/推送）
- [x] P4 views：日历美化（月度汇总条、热力格 4 级 + 边框联动、今天徽标、周末着色、hover 提升、图例）
- [x] P5 验证：typecheck / test（65 项）/ lint / build 全部通过

## 二期返工（用户反馈,已完成）

- [x] R1 oneshot 通道泛化：`cli:oneshot` 按 agent 走 adapter（buildArgs + parseLine 聚合 text/result），claude/codex 均可,未来新 agent 接入 adapter 后自动支持;超时放宽到 60s
- [x] R2 推送设置剥离：`PushSettings` 独立持久化（PersistedState.pushSettings,全局共用），设置对话框单独「推送」tab
- [x] R3 时间线设置只留模型选择：集成 Agent 下拉（列表来自 AGENT_MODELS 注册表）→ 型号下拉联动（切 agent 重置为该 agent 默认型号）;或自定义 OpenAI 兼容模型
- [x] R4 旧数据迁移（hydrate 时 timelineSettings.push → pushSettings,带测试）+ 全量验证（typecheck / 67 项测试 / lint / build 通过）

## 三期：推送格式 Skill（已完成）

- [x] S1 core：`PushSettings.formatSkillPath` + `buildPushReportData` / `renderPushReport`（占位符渲染、空数据整行剔除、首行剥 markdown 作标题）+ 5 项测试
- [x] S2 推送管线接入：配置了 skill 则 `readFile` 渲染,文件失效回退默认格式不阻塞推送
- [x] S3 设置 → 推送：格式 Skill 下拉（Prompt 库 .md 拍平,失效路径标注）+「在 Prompt 库创建示例 Skill」按钮（写入默认模板并自动选中、重扫树）
- [x] S4 验证：typecheck / 71 项测试 / lint / build 全部通过

占位符：`{{project}}` 项目名 / `{{date}}` 日期 / `{{stats}}` 统计行 / `{{summary}}` AI 日报正文 /
`{{runs}}` 交互列表 / `{{files}}` 变更文件列表 / `{{commits}}` 提交列表。
选模板替换而非 AI 重写：固化格式要求输出确定一致,AI 重写每次漂移。

## 执行结果与已知限制

- 钉钉加签（HMAC-SHA256 → Base64 → urlEncode）与 OpenAI 兼容 URL 拼接均有单测覆盖。
- webhook 域名白名单校验（仅 qyapi.weixin.qq.com / oapi.dingtalk.com 的 https）防误填。
- ~~集成 Agent 模型暂只支持 Claude~~ → 二期已泛化：oneshot 走 adapter,任何已集成 Agent 均可作日报模型。
- 会话标题自动生成仍走 claude（autoTitle 的既有行为,与日报模型配置无关）。
- 推送按钮一次推送到所有启用渠道，逐渠道 toast 成败。
- 复制/推送在未生成 AI 日报时退化为「统计 + run 标题列表」，不阻塞使用。
