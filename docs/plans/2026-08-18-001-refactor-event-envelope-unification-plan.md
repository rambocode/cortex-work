# 事件信封归一(Envelope Unification)改造方案

> 状态:提案 · 2026-08-18
> 结论先行:**不引入全局事件总线**。Electron IPC 本身就是总线(channel = topic),
> `CliStreamEvent` 已经是归一化事件 schema。缺的是**信封规范**——载荷形状、路由语义、
> 生命周期三件事各通道各写各的。本方案分四个阶段小步收敛,每阶段独立可交付、可回退。

## 1. 背景:为什么做这件事

2026-08 子代理并行派发连修 5 个 bug,复盘后发现没有一个是"缺总线",全部是信封问题:

| 事故 | 信封问题归类 |
|---|---|
| 子会话过程不流式 / 主会话被灌爆 | **路由**:接收端靠 `roleId`/`subagentCallId` 标记推断归属 |
| 子会话归档 invocations 恒为空 | **id 语义**:子命名空间沿用父 `runId`,配对逻辑按 runId 过滤 |
| 长任务中途过程被 GC | **生命周期**:query 命名空间无 owner,吃全局 10min gcTime |
| todo 转圈不收尾 | **生命周期**:收尾出口不覆盖子命名空间 |
| 工具 ⚠️ 错标 | **id 语义**:end 帧不按 `toolCallId` 定位 |

这类 bug 会随每个新事件域(research / workflow / automation…)重复出现,因为每个域都在
重新发明信封。

## 2. 现状盘点(2026-08-18 实测)

### 2.1 主进程 → 渲染端 channel 全景

`grep sender.send/webContents.send` 计 **40+ 个 channel**,preload 相应堆了 **52 个
`ipcRenderer.on` 监听**。按性质分三类:

**A 类 · 运行事件流**(高频、按会话路由、驱动流式 UI):

| channel | 载荷形状 | 发送点 |
|---|---|---|
| `cli:event` | `{ runId, sessionId, event: CliStreamEvent }` | 6 处:`ipc/cli.ts:905`、`ipc/roundtable.ts:317`、`ipc/orchestrate.ts:539`、`ipc/pi-delegate.ts:451/590`、delegate host 经注入的 pushEvent |
| `pi:event` | `{ uiSessionId, runId, event: PiSessionEvent }` ← **字段名漂移** | `ipc/pi-session.ts:263` |
| `workflow:run-event`、`automation:run-event`、`ask:event`、`tts:stream`、`pty:data` | 各自形状 | 各域一处 |
| research 域 | service 内部 `broadcast()`,sessionId 内嵌在 event 里 | `research/research-service.ts` |

**B 类 · 失效通知**(低频、"某数据变了,重新拉"):
`memory:changed`、`tasks:changed`、`tasks:resources-changed`、`roles:changed`、
`notes:changed`、`workflow:changed`、`automation:changed`、`store:push-settings-changed`、
`kws:config-changed`、`fs:dirChanged`…… 每个都是一条独立 channel + 一个独立 preload
监听 + 一个 DesktopBridge 方法,而渲染端的消费方式几乎都是同一句:invalidate 某些
React Query key。

**C 类 · UI 指令/单播**(点对点、有明确交互语义):
`update:state`、`notification:push`、`pi:uiRequest`、`spotlight:intent`、`pet:*`、
`reply-bubble:*`…… 形状天然各异,**不在本方案收敛范围**。

### 2.2 渲染端入口现状

- `handleCliEvent(qc, runId, ev, sessionIdHint)`(`packages/core/personal/messages.ts:1808`)
  与 `handlePiEvent(qc, sessionId, ev, runId)`(同文件 :2685)两套入口,pi 事件在后者内部
  再翻译成 `CliStreamEvent` 记 trace。
- 子代理事件的父/子分流在接收端完成:`run.subagentCards` 按 `subagentCallId` 查游标、
  剥标记、改 runId ——这段逻辑是 2026-08 修复后才正确的,但它本质是**接收端在补发送端
  没写清楚的信封**。

## 3. 目标与非目标

**目标**
1. A 类事件统一信封:载荷形状、字段名、id 语义全仓唯一。
2. 路由语义上移:**发送端决定目标命名空间**,接收端不再从事件内容推断归属。
3. B 类通知收敛为一条 channel,新增"某某变了"不再动 preload/DesktopBridge。
4. 每个会话级命名空间(chat/process/run-events)有明确生命周期 owner。

**非目标**
- 不做进程内 pub/sub 框架、不引入第三方事件总线库。
- 不动 C 类 UI 指令 channel。
- 不改 `CliStreamEvent` / `PiSessionEvent` 自身的事件类型定义。
- 不为"将来可能的多窗口订阅"预留抽象(见 §8 触发条件,到了再做)。

## 4. 信封契约(核心设计)

新增于 `apps/desktop/src/main/ipc/types.ts`(preload / core 共用):

```ts
/** 运行事件统一信封:主进程 → 渲染端所有"会话级流式事件"的唯一载荷形状。 */
export interface RunEventEnvelope {
  /** 信封版本,便于灰度与将来演进。 */
  v: 1;
  /** 事件域:决定渲染端交给哪个 reducer。 */
  domain: "chat" | "artifact" | "roundtable" | "orchestrate" | "research" | "workflow" | "automation";
  /**
   * 目标命名空间(= React Query key 的 sessionId)。发送端决定,接收端不得再推断。
   * 子代理完整过程 → 填 childSessionId;父会话卡片流 → 填父 sessionId。
   */
  sessionId: string;
  /** run 标识。子会话命名空间内 = subagentCallId(id 语义全仓唯一,见 §1 事故表)。 */
  runId: string;
  event: CliStreamEvent;
}
```

三条**不变量**(写进类型注释,评审据此把关):

1. **单一目的地**:一个信封只投递一个命名空间。需要"父卡片 + 子过程"两个视图时,由
   发送端**显式双发**两个信封(各带各的语义),不发一个含糊信封让接收端拆。
2. **id 语义随命名空间**:子命名空间的 `runId` 恒为 `subagentCallId`;信封内 event 不再
   携带 `roleId`/`subagentCallId` 等"给另一个命名空间看的"过滤标记。
3. **生命周期 owner**:谁创建命名空间,谁负责保活(`setQueryDefaults` gcTime)与出口清理
   (`clearProcess`/`clearRunEvents` 闭环)。信封不管生命周期,但评审时二者一起看。

## 5. 分阶段实施

### 阶段 P0 · 收口发送点(约 1 天,零行为变化)

**做什么**
- `ipc/types.ts` 定义 `RunEventEnvelope`(先只加 `v`/`domain` 字段,`sessionId`/`runId`/
  `event` 与现载荷同名同义,渲染端向后兼容)。
- 新增唯一发送函数(建议放 `ipc/run-events.ts`):

```ts
/** 运行事件唯一出口:isDestroyed 守卫、信封校验、agent-trace 埋点集中在此。 */
export function sendRunEvent(sender: WebContents, envelope: RunEventEnvelope): void;
```

- 6 个 `cli:event` 裸 `sender.send` 全部改走 `sendRunEvent`(channel 名暂不变,仍是
  `cli:event`,只是载荷多 `v`/`domain` 两个字段)。
- `pi:event` 载荷字段 `uiSessionId` → `sessionId` 对齐(preload `onPiEvent` 同步改,
  一次破坏性小改,当前仅一发一收)。
- 约定写进 CLAUDE.md:**新代码禁止绕过 `sendRunEvent` 直发运行事件**。

**验收**:现有 core/desktop 全部单测不改断言通过(载荷是超集);
`grep 'send("cli:event"' apps/desktop/src/main --include='*.ts' | grep -v run-events.ts` 为空。

**回退**:函数是纯转发,revert 单个 commit 即可。

### 阶段 P1 · B 类通知收敛(约 1-2 天,逐域迁移)

**做什么**
- 新 channel `sync:invalidate`,载荷 `{ scope: string; hint?: string }`
  (例:`{ scope: "tasks" }`、`{ scope: "memory", hint: "deleted" }`)。
- 渲染端一张**静态映射表**:`scope → React Query keys / Zustand 刷新动作`,与
  "WebSocket 事件只触发 invalidation"的既有纪律同构。
- 逐域迁移(每域一个独立 commit):`tasks:changed` → `roles:changed` → `notes:changed`
  → `memory:changed` → `automation:changed` → `workflow:changed` → 其余。
  旧 channel 迁完即删对应 preload 监听与 DesktopBridge 方法。

**收益**:preload 52 个监听预计砍掉 10+ 个;以后新增"某某变了"只加一行映射表,
不动 preload / bridge 契约。

**回退**:按域 revert,各域独立。

### 阶段 P2 · 子会话双发上移(约 3-5 天,唯一的中风险阶段)

**做什么**
- delegate 链路(`capabilities/delegate/server.ts` + `ipc/pi-delegate.ts`)对每个子代理
  事件产出**两个信封**:
  - 父信封:`{ domain:"chat", sessionId: 父id, runId: 父runId, event: 卡片级事件 }`
    (init/步进/摘要增量/终态——即今天 `subagentCard` 消费的最小集)
  - 子信封:`{ domain:"chat", sessionId: childSessionId, runId: subagentCallId,
    event: 剥净标记的完整事件 }`
- 渲染端 `handleCliEvent` 删除按标记推断的分流(`run.subagentCards` 游标查找、
  `recordRunEvent` 的剥标记双写),`SubagentCardState` 的折叠逻辑改为由子信封直接驱动
  子命名空间 reducer——与主会话同一条折叠代码路径。
- `messages.test.ts` 现有子代理用例(双写、降噪、并行工具、todo 收尾、gc 保活)全部保留,
  改为从"发送端产出的双信封"入口打入,断言不变——**断言不变是本阶段的安全网**。

**为什么值得**:2026-08 那批 bug 的结构性根因(接收端补信封)就消失在这一步;
`messages.ts`(4000 行)预计能拆出 300-400 行子代理路由逻辑。

**风险与对策**
- HMR/刷新恢复路径(`stage:"subagent"` 标记重建 `run.delegate`)依赖旧标记——恢复逻辑
  改为按信封 `sessionId` 是否为 side 会话判定;单测已有恢复用例覆盖。
- 圆桌(roundtable)与三段编排(orchestrate)仍走带 `roleId` 的旧语义——本阶段**不动**,
  它们的 roleId 是"同一命名空间内分段",与子代理的"跨命名空间"是两回事。

**回退**:发送端保留旧单发代码路径于同 commit 的 feature flag(`envelope.v` 判定),
渲染端兼容两版信封一个版本周期后删旧路径。

### 阶段 P3 · 远期(触发条件制,默认不做)

真 pub/sub(MessagePort/BroadcastChannel、多消费者订阅)只在满足任一触发条件时再评估:
- 出现第二个需要订阅同一事件流的窗口(如独立监控窗);
- 插件生态需要第三方订阅运行事件;
- A 类事件出现"一信三投以上"的真实需求。

在此之前,任何"先把总线搭起来"的提案都应被拒——追查成本立刻发生,收益要等场景出现。

## 6. 不变量清单(评审 checklist)

- [ ] 运行事件只经 `sendRunEvent` 出主进程;
- [ ] 接收端不从 event 内容推断目标命名空间(信封 `sessionId` 是唯一真相);
- [ ] 子命名空间 `runId` ≡ `subagentCallId`;
- [ ] 新建会话级 query 命名空间同时声明保活(`setQueryDefaults`)与清理出口;
- [ ] 同一事件不重复折叠进两个命名空间的同一类视图(降噪原则);
- [ ] B 类"changed"一律走 `sync:invalidate` 映射表,不新开 channel。

## 7. 工作量与顺序汇总

| 阶段 | 工作量 | 风险 | 依赖 |
|---|---|---|---|
| P0 发送点收口 | ~1 天 | 低(载荷超集,零行为变化) | 无 |
| P1 通知收敛 | ~1-2 天 | 低(逐域独立) | P0 的约定生效 |
| P2 双发上移 | ~3-5 天 | 中(断言不变作安全网) | P0 |
| P3 真总线 | — | — | 触发条件 |

P0/P1 可与日常需求并行插空做;P2 建议单独排期、避开发版窗口。

## 8. 与既有文档的关系

- 本方案不改 `docs/plans/2026-08-06-001-refactor-pi-gateway-worker-plan.md` 的 worker
  JSONL 协议(那是 worker→主进程一跳,本方案管主进程→渲染端一跳)。
- 落地 P0 时在 `docs/module-map.md` 补 `ipc/run-events.ts` 条目(仓库维护规则)。
