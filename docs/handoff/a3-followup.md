# A3（凭据 / OAuth / Provider 偏好）→ 跨文件需求

阶段② 侧已完成的部分见 `apps/desktop/src/main/providers/`。以下一项**必须改我职责外的文件**，
需要 lead 协调；未改之前，baseUrl 覆盖只在 UI 与状态里生效，**不会作用到 pi 的真实请求**。

---

## 1. `agents/pi-providers.ts` 需要读取 main-owned 的 baseUrl 覆盖（阻塞项）

### 现状链路

`builtinProviderConfig(provider, catalogBaseUrl)`（`pi-providers.ts:165`）判断「用户是否显式覆盖了
内置 endpoint」时读的是 `provider.baseUrl`，即 `PiProviderInput.baseUrl`
（`ipc/types.ts:267`）。这个对象由**渲染端**经 `CliStartRequest.provider` 传入
（`ipc/cli.ts:452 / 692 / 1317` 三处 `writePiExtension(req.provider)`），源头是已废弃的
`PersistedState.providerSettings`。

阶段② 的覆盖值落在 **main-owned** 的 `~/.cortex-desktop/provider-prefs.json`
（经 `providerAuth:setBaseUrl` 写、`ProviderAuthStatus.baseUrlOverride` 只读回显）。
渲染端**读不到也不该持有**它——它不是渲染端状态，塞回 `personal-workspace.json` 会被
`toPersistedState` 白名单 clobber，这正是它落在 main 侧的原因。

**结论：当前两者不连通。** 用户在设置页填了自建网关，`writePiExtension` 渲染出的 extension 里
不会有 `baseUrl`，请求照旧发往官方端点——A5 在 `a5-ui.md` 第 1 条点名要避免的那种静默失败。

### 建议改法（2 行，纯加法）

`apps/desktop/src/main/providers/prefs.ts` 已经为此导出了**同步**读接口（刻意做成同步：
`renderPiExtension → writePiExtension` 是纯同步且跑在 spawn 前一刻，异步预热会有竞态窗口，
spawn 早于加载完成时静默拿到「无覆盖」）：

```ts
import { getBaseUrlOverride } from "../providers/prefs";

function builtinProviderConfig(provider: ProviderInput, catalogBaseUrl?: string): Record<string, unknown> {
  const config: Record<string, unknown> = authFields(provider);
  // main-owned 的用户覆盖优先于渲染端传来的 baseUrl（后者源自已废弃的 providerSettings）。
  const override = getBaseUrlOverride(safeId(provider.id));
  const effective = override ?? provider.baseUrl;
  const configured = normalizeBaseUrl(effective);
  if (configured && normalizeBaseUrl(catalogBaseUrl) !== configured) config.baseUrl = effective.trim();
  return config;
}
```

要点：

- **查询键用 `safeId(provider.id)`**。`providerAuth:setBaseUrl` 收到的是 Catalog 里的 provider id
  （UI 列的就是 Catalog），而 `classifyPiProvider` 也用 `safeId(provider.id)` 去 Catalog 匹配，
  两者同域；直接用 `provider.id` 在 id 含大写/空格时会查不中。
- **只改 `builtinProviderConfig`，不动 `customProviderConfig`**。计划 §4.2 把 baseUrl 覆盖限定为
  内建 Provider 的高级选项；自定义 Provider 的 baseUrl 本就写在它自己的 Pi Provider JSON 里，
  再叠一层覆盖会有两个真源。
- 与既有的 `normalizeBaseUrl` 比较逻辑不冲突：覆盖值若恰好等于 Catalog 的官方地址，仍按「未覆盖」
  处理、不下发 `baseUrl`，这是原有的期望行为。
- `prefs.ts` 的读对损坏/缺失文件是降级返回空偏好、不抛错，不会让 extension 生成崩掉。

### 建议补的单测（在 `pi-providers.test.ts`）

- 有覆盖时 `buildPiProviderConfig` 下发覆盖值，且**仍不含 `models`**（本次事故的核心不变量）。
- 覆盖值等于 Catalog baseUrl 时不下发 `baseUrl`。
- 无覆盖时行为与改动前逐字一致（回归护栏）。

---

## 2. 附带说明：`PiProviderInput` 的长期归属（不阻塞，阶段③ 再定）

`CliStartRequest.provider` 由渲染端拍平传入，这套形状是旧 `providerSettings` 时代的产物。
阶段③ Gateway 收编后，内建 Provider 的 extension 配置理论上应该完全由主进程从
「Catalog + provider-prefs + 凭据金库」构造，渲染端只需要传 `{ providerId, modelId }`。
本次不动，避免与阶段① / ③ 的改动互相踩。
