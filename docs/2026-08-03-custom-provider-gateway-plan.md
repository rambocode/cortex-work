# 自定义 Provider 会话接线 + 聚合网关(new-api)低负担接入方案

日期:2026-08-03
范围:Cortex Desktop pi 聊天链路的自定义供应商支持。前置研究见
`docs/2026-07-30-pi-tui-provider-model-capabilities-research.md` 与
`docs/2026-07-30-pi-provider-capability-fix-plan.md`(下称「能力研究」「能力修复计划」)。

## 0. 背景:三个叠加的问题

1. **自定义 Provider 未接进会话(功能性缺口,P0)**
   用户在设置页保存的自定义 Provider JSON(`provider-custom.json`)只有「保存/校验/Secret 管理」
   通道在消费(`ipc/provider-auth.ts`)。聊天会话的 spawn 链路
   (`ipc/pi-session.ts` 的 `preparePiOpenRequest` → `providers/pi-provider-input.ts` 的
   `resolvePiProviderInput`)只解析随包 Catalog 的内建 Provider,自定义 id 解析为
   `undefined` 后**继续 spawn**:pi 收到孤立的 `--model gpt-5.6-luna`,匹配不到,走
   `findInitialModel` 兜底链选中 `azure-openai-responses/gpt-5.4`,发消息时报
   `No API key found for azure-openai-responses`。
   —— 用户视角:配置保存成功,聊天却报一个毫不相干的 Azure 错误。

2. **能力字段让用户手填(产品性缺口,P1)**
   能力修复计划确立了「缺字段拒绝注册、不猜默认值」的红线,但只落地了「拒绝」这一半。
   `contextWindow / maxTokens / input / reasoning / cost` 全要用户查资料手填,认知负担极高。
   而补全数据源 Cortex 手里就有:随包 Provider Catalog 就是 pi 内置目录的完整快照
   (`CatalogModel` 含全部能力字段)。

3. **聚合网关没有产品化形态(产品性缺口,P1)**
   new-api / one-api 这类 OpenAI 兼容网关是企业接入的主流形态,有标准 `GET /v1/models`
   可发现模型列表。现状要求用户手写整段 Pi Provider JSON,而合理形态是与云平台行同构:
   填地址 + Key → 自动拉模型 → 勾选启用,零手填。

## 1. 设计原则(继承自能力修复计划,不可回退)

- **不猜能力**:写进 pi 的每个模型必须携带完整、确定的能力元数据;「未知」是显式状态,
  不能折算成 `text-only / no-reasoning`。
- **不静默回退**:provider 解析失败必须响亮失败并给出设置入口,绝不让 pi 落到用户没选过的
  模型上(本次 azure 事故的直接教训;`gateway.ts` 单发路径已有此约束,RPC 路径补齐)。
- **明文不落盘**:apiKey/Authorization 只以 `${secret:NAME}` 引用存在于持久化 JSON 与
  extension 文件中,真值经 safeStorage 金库 → spawn 环境变量注入。
- **降低认知负担**:能力由系统解析,用户只做「选择与确认」;JSON 编辑器降级为高级入口。
- **`/models` 只负责发现,不负责能力**(能力研究 §4):标准响应只有 `id/created/owned_by`,
  能力一律从受信目录解析。

## 2. 现有资产盘点(方案全部复用,不新造)

| 资产 | 位置 | 在本方案中的角色 |
| --- | --- | --- |
| 自定义 Provider JSON 校验/落盘 | `main/providers/custom-providers.ts` | 阶段 A 的数据源(`listCustomProviders`) |
| Secret 引用语法与解析 | `main/providers/secrets.ts`(`collectSecretRefs` / `resolveSecretRefs`) | 阶段 A 的 env 注入前置 |
| Secret 金库 | `main/providers/credentials.ts`(`readSecrets` / `listSecretNames`) | 真值来源(仅主进程) |
| extension 渲染管线 | `main/agents/pi-providers.ts`(`writePiExtension` 等) | 阶段 A 扩展出「整段 JSON 注册」变体 |
| baseUrl 覆盖 | `main/providers/prefs.ts` + `BaseUrlOverride.tsx` | 已满足「api-key 供应商自定义接入地址」需求,不动 |
| 随包 Provider Catalog | `main/providers/catalog.ts` + `contract.ts`(`CatalogModel`) | 阶段 B 能力解析器的受信目录 |
| endpoint `/models` 探测 | `main/ipc/provider.ts`(多 URL 探测,现只提取 id) | 阶段 B 的模型发现通道 |
| spawn env 注入 | `main/ipc/cli.ts` 的 `spawnEnvFor`(`CORTEX_PI_KEY`) | 阶段 A 扩展为多变量注入 |

## 3. 阶段 A:自定义 Provider 接进 pi 会话(先能用)

### A1. 解析链补自定义分支

`preparePiOpenRequest`(`ipc/pi-session.ts:186` 附近)现有逻辑:

```
if (!prepared.provider && prepared.providerId)
  prepared.provider = await resolvePiProviderInput(prepared.providerId);
if (prepared.provider) prepared.piExtensionPath = writePiExtension(prepared.provider);
```

改为三段式解析,新增 `resolveCustomProviderExtension(providerId)`(建议放
`main/providers/custom-provider-runtime.ts`,避免 `pi-providers.ts` 逼近行数上限):

1. 命中 Catalog → 走现有 `resolvePiProviderInput` + `writePiExtension`(内建路径,不变);
2. 未命中 Catalog → 查 `listCustomProviders()`,命中则:
   - `JSON.parse` 保存的 JSON(保存时已过校验,此处解析失败按响亮错误处理);
   - 收集 `${secret:NAME}` 引用,从 `readSecrets()` 取真值;**缺任何一个引用即抛
     结构化错误**(复用 `PiProviderConfigError` 的形态),不得带着未解析占位符 spawn;
   - 渲染 extension:`pi.registerProvider(safeId(id), {...json})`,JSON 中每个
     `${secret:NAME}` 替换为 `$CORTEX_PI_SECRET_<N>` 环境变量占位(pi 原生支持 `$ENV`
     插值),文件 0600 落 `userData/pi-providers/`,与现有管线同目录同权限;
   - 返回 `{ extensionPath, secretEnv: Record<string,string>, providerId: safeId(id) }`,
     `secretEnv` 经 `spawnEnvFor` 的扩展点合并进子进程环境(参照 `computerUseEnv` 的
     传递模式,新增 `prepared.customProviderEnv`,主进程内部字段、不过 IPC 回传)。
3. 两处都未命中 → **`pi:open` 直接 reject**,错误文案指明
   「供应商 <id> 未配置,请在设置 → 模型服务中检查」。这是对「不静默回退」红线的落实:
   宁可开会话失败,不可让 pi 换模型。

`--provider safeId(id)` 与 `--model <modelId>` 照常由 `buildRpcArgs` 下发
(`agents/pi-rpc.ts:353-355`,自定义路径此后恒有 `req.provider`,无需改该函数)。

### A2. 明文红线的落实细节

- extension 文件里**只有** `$CORTEX_PI_SECRET_<N>` 占位,与现有 `$CORTEX_PI_KEY` 同一模式;
- 环境变量名按 secret 名的稳定序号派生(同一会话内确定),值仅存在于子进程 env;
- `resolveSecretRefs` 的 missing 语义保持:缺失引用保留原样并报错,绝不替换为空串;
- 单发路径(`cli.ts` / ask / automation)本阶段**不接**自定义 Provider——先收敛在聊天
  RPC 一条路径验证,避免五个调用点同时改;单发路径命中自定义 id 时同样响亮失败。

### A3. 渲染端:模型选择器并入自定义模型

- 聊天模型选择器目前只消费随包 Catalog(`core/desktop/provider-catalog.ts` 镜像类型)。
  新增数据源:`bridge.providerCustomList()`(preload 已存在)→ 解析各定义的
  `models[]`,以「自定义」分组并入选择器,条目携带只读能力徽标(直接读 JSON 里的
  `input/contextWindow/reasoning`);
- `extensionFingerprint` 计入所选自定义 Provider 的 `updatedAt`(定义变更 → 触发会话
  重开,与 webSearch 开关同机制);
- 设置页自定义 Provider 卡片增加「在聊天中可用」的状态提示,消除「保存了但不知道在哪用」
  的断层。

### A4. 阶段 A 验收

1. 用户 JSON(修正 `baseUrl` 为 `http://openai.abssqr.cn/v1` 后)保存 → 聊天选
   `公司模型/gpt-5.6-luna` → 消息正常收发,请求打到公司网关;
2. extension 文件与所有落盘 JSON 中 grep 不到任何真实 key;
3. 删掉金库中被引用的 Secret 后开会话 → `pi:open` reject,错误指明缺哪个 Secret;
4. 选择一个既不在 Catalog 也不在自定义列表的 providerId → `pi:open` reject,
   **pi 进程不被 spawn**;
5. 修改自定义 JSON 保存后,已开会话下一轮触发重开并加载新定义。

## 4. 阶段 B:聚合网关 preset + 能力自动解析(再好用)

### B1. 能力解析器(主进程纯函数模块)

新增 `main/providers/capability-resolver.ts`:

```
resolveCapabilities(modelId, endpointFormat, catalog):
  → { status: "known", source: "catalog", model: CatalogModel }   // 命中受信目录
  | { status: "unknown" }                                          // 显式未知
```

- 匹配键是 `modelId + endpointFormat`,不是裸 id(能力研究 §5.3:同名模型经不同协议,
  `compat` 与推理参数翻译不同)。命中目录后,`api` 字段按网关实际协议改写为
  `openai-completions`,`compat` 只保留与该 api 兼容的部分,其余能力字段
  (`input/reasoning/thinkingLevelMap/contextWindow/maxTokens`)照抄;
- id 规范化仅做**保守**变换(小写、去 `-latest` 后缀做别名匹配),不做模糊包含匹配——
  宁可 unknown 也不错配;
- `unknown` 不折算为任何默认值,由 UI 引导用户走「参照模型」补全。

### B2. 「参照模型」补全(unknown 的一次点选出路)

未识别模型在 UI 上灰显,附「选择参照模型」下拉(数据源 = 全 Catalog 模型,可搜索)。
用户选定后,能力从参照模型整套继承,写入生成的模型定义,并记录
`capabilitySource: "reference:<provider>/<model>"` 供只读展示与日后审计。
这是把「六个字段手填」压缩成「一次选择」,同时保持写进 pi 的值完整、确定。

### B3. 聚合网关接入流程(设置页新增接入类型)

1. 用户填:名称、接入地址(如 `http://openai.abssqr.cn/v1`)、API Key(进金库,
   自动生成 `${secret:...}` 引用);
2. 点「连接」→ 主进程用现有 endpoint 探测(`ipc/provider.ts`)调 `GET /v1/models`
   拉 id 列表;
3. 逐 id 过 `resolveCapabilities`:已识别 → 打勾即用(能力徽标只读);未识别 → 走 B2;
4. 用户勾选启用的模型 → 主进程**生成**一份合法的 Pi Provider JSON,写入
   `provider-custom.json`(复用阶段 A 的全部会话消费链路;聚合网关只是自定义 Provider
   的一个「生成器前端」,存储与运行时零新概念);
5. 「刷新模型列表」按钮支持增量同步:网关新增模型 → 追加候选;已启用模型消失 → 标警示
   而非静默移除。

### B4. UI 原则

- 顺路径(官方模型经网关)全程零手填、零 JSON、零能力字段;
- 能力一律只读徽标 + 来源标注(`目录` / `参照 <model>`),没有 checkbox
  (能力修复计划 §5.5 的既定方向);
- 整段 JSON 编辑器保留为「高级」入口,服务连参照都不适用的极端情况;
- 探测失败(网关不可达 / 401)在「连接」步骤当场报错,不允许带着失败状态保存。

### B5. 阶段 B 验收

1. 对接真实 new-api:填地址 + Key → 列表出现全部模型,官方同名模型(如 gpt-4o)
   自动标注完整能力且与 pi 内置目录逐字段一致;
2. `gpt-5.6-luna` 类未知 id 显示 unknown,选参照模型后可启用,能力等于参照模型;
3. 已识别的视觉模型经网关发图不出现 `(image omitted: ...)`;text-only 模型发图前被
   UI 阻断并提示;
4. 生成的 JSON 通过 `validateCustomProviderJson` 全部校验(生成器与校验器同契约);
5. 全流程无一处要求用户输入能力数字。

## 5. 明确不做 / 边界

- 不调用供应商私有能力接口、不发测试图片探测能力(能力研究 §5.4:费用与误判);
- 不改内建 Provider 的注册方式(仍绝不传 `models`);
- baseUrl 覆盖机制(`prefs.ts`)不动——它已满足「api-key 供应商自定义接入地址,
  不填走默认、填了覆盖」;
- 单发路径(Reply/Research 等 Gateway 消费方)接入自定义 Provider 另立后续阶段,
  本方案只覆盖聊天 RPC 路径。

## 6. 实施顺序与涉及文件

**阶段 A(P0,先行)**
- `main/providers/custom-provider-runtime.ts`(新):JSON → extension + secretEnv;
- `main/ipc/pi-session.ts`:三段式解析 + 响亮失败;
- `main/ipc/cli.ts`:`spawnEnvFor` 合并 `customProviderEnv`;
- `main/ipc/types.ts`:`PiOpenRequest.customProviderEnv`(主进程内部字段);
- `packages/core/desktop/*` + 模型选择器组件:并入自定义模型 + fingerprint;
- 单测:secret 注入(含缺失拒绝)、未知 provider reject、extension 无明文。

**阶段 B(P1,依赖 A)**
- `main/providers/capability-resolver.ts`(新)+ 单测(命中/别名/unknown/协议改写);
- `main/ipc/provider.ts`:`/models` 探测结果透传完整 id 列表;
- 设置页聚合网关向导(views)+ JSON 生成器 + 单测(生成物过校验器);
- `docs/module-map.md` 同步补条目(仓库维护规则)。
