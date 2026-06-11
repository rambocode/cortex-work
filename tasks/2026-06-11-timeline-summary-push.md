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

## 二期返工（用户反馈）

- [ ] R1 oneshot 通道泛化：`cli:oneshot` 按 agent 走 adapter（buildArgs + parseLine），支持 claude/codex 及未来 agent
- [ ] R2 推送设置剥离：`PushSettings` 独立持久化（全局,未来推送场景共用），设置对话框单独「推送」tab
- [ ] R3 时间线设置只留模型选择：集成 Agent 列表（按所选 agent 联动型号）+ 自定义模型
- [ ] R4 旧数据迁移（timelineSettings.push → pushSettings）+ 测试更新 + 全量验证

## 执行结果与已知限制

- 钉钉加签（HMAC-SHA256 → Base64 → urlEncode）与 OpenAI 兼容 URL 拼接均有单测覆盖。
- webhook 域名白名单校验（仅 qyapi.weixin.qq.com / oapi.dingtalk.com 的 https）防误填。
- 集成 Agent 模型暂只支持 Claude（haiku/sonnet/opus）——主进程 `cli:oneshot` 通道目前只 spawn claude；codex 一次性输出含杂讯，待该通道扩展后再开放。
- 推送按钮一次推送到所有启用渠道，逐渠道 toast 成败。
- 复制/推送在未生成 AI 日报时退化为「统计 + run 标题列表」，不阻塞使用。
