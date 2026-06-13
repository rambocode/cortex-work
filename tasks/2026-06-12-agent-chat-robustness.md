# Agent 聊天健壮性：纯净启动 / 启动状态 / 超时重试 / 编辑重发

## 需求
1. 项目内启动 claude code / codex 时禁用所有 MCP 服务与 skills，默认只保留全局指令。
2. LLM 启动可能很慢且无反馈：typing 占位要区分阶段（正在启动… / 正在思考…）并显示已等待时长。
3. agent 调用设超时：超时后杀掉进程、提示用户重试（结合 4 的编辑重发即可重试）。
4. 所有用户消息可「编辑重发」：编辑后该消息及其后的所有消息清空，按新内容重新发送。

## 方案
1. **纯净启动**（主进程 adapter 层，始终生效）
   - claude：`--strict-mcp-config --mcp-config {"mcpServers":{}}`（清空 MCP）；
     skills 开关语义反转为**默认关**（`useOwnSkills !== true` 时加 `--disable-slash-commands`）。
   - codex：`-c mcp_servers={}`（TOML 覆盖清空 MCP）。
   - PersonalComposer 的 Skills pill / ChatArea toggle 同步改为默认关。
2. **启动状态**（core/personal/messages.ts）
   - RunState 增加 phase（starting → thinking）与 lastEventAt；
   - typing 文本：spawn 后「正在启动 X…」，收到 init 事件后「已连接,正在思考…」；
   - 每 5s ticker 刷新 typing 文本追加「已等待 N 秒」，首个 tool/text/result 后停止。
3. **超时看门狗**（与 ticker 合一）
   - `RUN_STALL_TIMEOUT_MS = 120s`：距上一事件超时且未收尾 → killCli + 超时提示消息
     （引导用户用「编辑重发」重试）+ 复位 running 状态；其后真正的 exit 事件走兜底清理。
4. **编辑重发**
   - messages.ts：`truncateForEdit`（纯函数）+ `editResend(session, path, uid, text, attachments)`：
     截断到该消息之前 → 立即落盘 → 走 send() 重发。
   - UI：用户消息 hover 出现「编辑」（运行中隐藏）→ 原文填入 composer + 顶部提示条
     「编辑重发将清除其后所有消息（取消）」→ 发送时走 editResend。
   - 已知取舍：CLI 侧 resume 上下文无法真正回滚（agent 仍记得被清掉的轮次），UI 与持久化会截断。

## 任务
- [x] claude/codex adapter 纯净启动参数 + 单测
- [x] Skills 默认关（composer pill / toggle 语义）
- [x] typing 分阶段 + 等待时长 ticker
- [x] 超时看门狗 + 超时提示
- [x] truncateForEdit 纯函数 + editResend + 单测
- [x] PersonalChatArea / PersonalComposer 编辑重发 UI + CSS
- [x] 全套测试 / lint / typecheck

## 执行结果
- **纯净启动**：[claude.ts](../apps/desktop/src/main/agents/claude.ts) 始终带
  `--strict-mcp-config --mcp-config {"mcpServers":{}}`；skills 语义反转为默认禁用
  （`useOwnSkills !== true` 即加 `--disable-slash-commands`）。
  [codex.ts](../apps/desktop/src/main/agents/codex.ts) 始终带 `-c mcp_servers={}`。
  Composer 的 Skills pill 与 toggle 同步改为默认关。
- **启动状态**：[messages.ts](../packages/core/personal/messages.ts) RunState 增加
  phase/lastEventAt/watchdog；typing 占位「正在启动 X…」→ 收到 init 后「X 正在思考…」，
  等待 ≥5 秒起每秒滚动显示「已等待 N 秒」（typing 为瞬态,刷新不触发落盘）。
- **超时看门狗**：启动阶段 90s 无任何事件 / 运行中 300s 静默（容忍长工具执行）→
  杀进程 + 追加超时提示（引导「编辑重发」重试）+ 复位 running;后续 exit 事件走兜底清理。
- **编辑重发**：`truncateForEdit` 纯函数 + `editResend` action（运行中禁止;截断→落盘→重发）；
  用户消息 hover 出现「编辑重发」按钮（复用 .m-tts-actions 样式），原文填入 composer 并出
  提示条「发送后将清除这条消息之后的所有内容（取消）」。
- **【追加】agent 记忆同步截断**（用户确认直接改 CLI 会话文件）：
  - 新增 [session-trim.ts](../apps/desktop/src/main/ipc/session-trim.ts)（纯逻辑不 import electron，
    IPC 注册挂在 cli.ts 的 `cli:trimSession`）：
    - claude：扫 `~/.claude/projects/*/<session-id>.jsonl`，user 行按「原文 + 同文序号」
      定位（实测验证 parentUuid 线性链 0 断链，尾部截断后链自洽）；
    - codex：递归找 `~/.codex/sessions/**/rollout-*<thread-id>.jsonl`，匹配
      `response_item/message/user` 的 input_text（兼容 `<user_request>` 附件包装）；
    - 截断前写 `.bak` 备份；找不到/序号越界/解析失败一律返回 false。
  - editResend：编辑第一条 → 丢弃 resume id 重开全新会话（记忆天然干净）；
    其余 → 调 `bridge.trimAgentSession` 尽力截断，失败静默退化为带旧记忆 resume。
  - 风险已知：CLI 会话文件是内部格式（行带 version 字段），CLI 大版本升级可能需适配；
    有 .bak 兜底,且任何异常都不会阻塞重发。
- 测试：claude/codex adapter 各 +1/+1 改 1，core messages +6（typingText/truncateForEdit）；
  全仓 268 用例、typecheck、lint 全绿。
- UI 手感（typing 滚动计时、编辑条交互）留待用户手动验证。
