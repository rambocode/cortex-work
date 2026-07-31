# A5（渲染端）→ 主进程侧的跨文件需求

来源：`docs/2026-07-30-pi-provider-capability-fix-plan.md` 阶段①·2.3 / 阶段③·4.2 / §5 的渲染端落地。
渲染端已按现有 `DesktopBridge` 契约做完；以下 4 项**必须由主进程侧补齐**，否则对应 UI 只能停在降级态。

---

## 1. `baseUrl` 覆盖没有 IPC（计划 §4.2 明确要求「高级 baseUrl 覆盖」）

`DesktopBridge` 与 `apps/desktop/src/main/providers/contract.ts` 里都**没有**写入 baseUrl 覆盖的方法。
`CatalogProvider.baseUrl` 是 Catalog 里的只读默认端点，不是用户覆盖值。

渲染端现状：`ProviderDetailPanel.tsx` 的「高级 → Base URL 覆盖」输入框做成 **disabled + 说明为什么**
（i18n key `providers.baseUrlOverrideUnavailable`）。刻意不做成「能填但不生效」——那会让用户以为
配好了自建网关，请求其实还发往官方端点。

**需要补**：`providerAuthSetBaseUrl?(providerId: string, baseUrl: string | undefined)`
（或并进现有的 `providerAuthSetApiKey`），并让 `ProviderAuthStatus` 带上当前生效的覆盖值供回显。
补齐后把该输入框的 `disabled` 去掉即可，UI 其余不用动。

---

## 2. Catalog 时代没有「默认模型」字段

`PersistedState.providerSettings`（含 `defaultProviderId` / `defaultModel`）已标 `@deprecated`，
且主进程首启会**删除**整个字段。但目前它仍是全局默认模型的唯一落点：

- `SettingsMenu.tsx` 的 Pi 分区「默认模型」读写 `setProviderDefaults({ defaultProviderId, defaultModel })`；
- `core/personal/messages.ts` 的 `resolveSessionModelRef()` 用它做会话级引用的回退。

删除后二者都会解析出空引用 → 进入「未配置模型」阻断态。**这是 §5 期望的行为**（不自动回退），
但用户重新登录 Provider 后没有地方存新的全局默认，等于每个会话都得单独选模型。

**需要补**：`PersistedState` 增加 Catalog 时代的默认模型字段，例如
`defaultModelRef?: { providerId: string; modelId: string }`。
渲染端只需把 `SettingsMenu.tsx` 的 `defaultRef` 与 `messages.ts:resolveSessionModelRef()` 两处切过去，
改动很小。**我没有自行改 `core/desktop/types.ts`**（按分工约定）。

---

## 3. 旧配置清理提示（§5）—— **已完成，无需主进程配合**

`ProviderManagerModal` 顶部已渲染一次性提示，点「知道了」置 `noticeAcknowledged`，
随下一次全量保存落盘（有单测覆盖「点完不再弹」）。

配套改动（`core/store/personal.ts`）：
- `PersonalState` 增加 `legacyProviderSettingsCleared` 只读镜像 + hydrate 回灌；
- **`toPersistedState` 白名单已加上该字段** —— 这是 `types.ts` 里那条 ⚠️ 的直接落实：
  白名单构造会整份覆盖磁盘，漏掉的字段会被渲染端下一次全量保存抹掉。
- 新增 `acknowledgeLegacyProviderNotice()` setter。

`hiddenProviderIds` 确认**不需要**镜像：它落在 main-owned 的 `provider-prefs.json`、
经 `ProviderAuthSnapshot.hiddenProviderIds` 回读，本就绕开了白名单 clobber。

> **给后续往 `PersistedState` 加字段的人**：新字段必须同步加进 `toPersistedState` 白名单，
> 否则主进程写入的值会被渲染端下一次全量保存静默抹掉。

---

## 4. Research / Reply 的模型解析仍走旧链路（属阶段③·4.1 Gateway 收编）

渲染端已经把这两处的**模型选择 UI** 换成 Catalog 驱动的 `ModelRefField`
（写入 `{providerId, modelId}`，悬空即阻断，不回退）。但真正执行时的解析仍在主进程：

- `main/reply/draft-generator.ts` + `main/reply/resolve-model.ts`
- `main/research/research-model-gateway.ts`
- `packages/core/research/model-selection.ts` 的 `selectResearchModel()`
  —— 它接受 `fallbackProviderId` / `fallbackModel` 并做**静默回退**，与 §5「不自动回退」直接冲突。

渲染端为了让「界面显示的模型」与「实际会用的模型」不再分家，已经把
`ResearchSettingsSection` 的出站说明改成直接从 Catalog 推导（loopback 判定仍复用
`core/research/model-selection.isLoopbackBaseUrl`），不再调 `resolveResearchModelDisplay`。

**需要注意**：`packages/views/cortex-desktop/research/modelDisplay.ts` 现在只剩新建研究表单在用，
Gateway 收编时应连同 `selectResearchModel` 的回退语义一起处理。

---

## 5. Computer Use 的模型引用没有 providerId（提醒 Gateway 侧）

`generalSettings.computerUse.groundingModel` 是**裸 `modelId` 字符串**，不是 `ModelRef`。
原因见 `ComputerUseSection.tsx` 的注释：pi 只注册会话选中的那一个 provider，别的 provider 的模型
不在它的 modelRegistry 里，渲染端无法预知运行时会用哪个 provider。

渲染端已做的收窄：候选只列 Catalog 中 `input` 含 `image` 的模型（电脑操作必须看得见屏幕），
但存的仍是裸 id。**Gateway 若要按 `{providerId, modelId}` 寻址它，需先定 providerId 的来源。**

---

## 附：渲染端已做完的部分（供交叉验证）

- 发送前 vision 阻断：`packages/core/personal/messages.ts` 的 `usePersonalActions().send`，
  位于 RPC(`sendPiTurn`) 与 CLI(`bridge.startCli`) 的**共同上游**、且在任何副作用之前。
  三态判定（supported / unsupported / **unknown 独立成态**）在 `packages/core/personal/modelCapabilities.ts`。
  这一层只是友好拦截，主进程仍是最终权威。
- Provider 管理页：`packages/views/cortex-desktop/personal/settings/provider/**`（每个文件 ≤ 275 行）。
  **已彻底删除**模型增删、能力 checkbox、上下文手填、`enabled` 开关——有单测断言详情面板里
  `input[type=checkbox]` 数量为 0（事故根因回归）。
