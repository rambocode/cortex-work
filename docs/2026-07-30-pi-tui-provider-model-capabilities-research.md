# Pi TUI Provider 与模型能力配置研究

日期：2026-07-30  
范围：当前仓库锁定的 `@earendil-works/pi-coding-agent@0.82.1` / `@earendil-works/pi-ai@0.82.1`，以及 Cortex Desktop 当前 provider 配置链路。

## 结论

Pi 已经把模型能力作为模型目录中的系统元数据维护，不是用户偏好。每个 `Model` 都包含 `reasoning`、`thinkingLevelMap`、`input`、`contextWindow`、`maxTokens` 和 `compat`；Pi 的 `--list-models`、会话运行时及图片消息降级逻辑都直接消费这些字段。证据见：

- `node_modules/.pnpm/@earendil-works+pi-ai@0.82.1_@modelcontextprotocol+sdk@1.29.0_zod@4.4.3__ws@8.21.0_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/types.d.ts:637-655`
- `node_modules/.pnpm/@earendil-works+pi-coding-agent@0.82.1_@modelcontextprotocol+sdk@1.29.0_zod@4.4.3__ws@8.21.0_zod@4.4.3/node_modules/@earendil-works/pi-coding-agent/dist/cli/list-models.js:51-58`
- `node_modules/.pnpm/@earendil-works+pi-ai@0.82.1_@modelcontextprotocol+sdk@1.29.0_zod@4.4.3__ws@8.21.0_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js:1-27`

当前问题的直接原因不是 Pi 或 GPT 不支持图片，而是 Cortex 生成的 extension 把 Pi 内置的完整模型定义替换成了简化定义，并为缺失字段写入 `reasoning: false`、`input: ["text"]`、`contextWindow: 131072`、`maxTokens: 8192`。Pi 随后依据这份错误元数据主动把图片替换成 `(image omitted: model does not support images)`。

因此，Cortex 不应让用户选择“推理/视觉/上下文长度”。应按 provider route 与 model ID 自动解析模型能力，设置页只读展示；对于 Pi 已知的原生 provider，应只覆盖认证和 endpoint，不传 `models`，从而保留 Pi 内置目录。对于代理或自定义 provider，应从受信模型目录复制完整能力，无法确认时明确标记为 `unknown`，不能把“未知”默认为“不支持图片”。

## 1. Pi 如何配置 provider 与模型

### 1.1 模型能力属于 `Model` 定义

Pi 的 `Model` 类型把下列信息定义为模型的一部分：

| 字段 | 含义 |
| --- | --- |
| `api` / `provider` / `baseUrl` | 实际传输协议与路由 |
| `reasoning` / `thinkingLevelMap` | 是否支持推理及推理档位映射 |
| `input` | 支持 `text`、`image` 中的哪些输入 |
| `contextWindow` / `maxTokens` | 上下文窗口与最大输出 |
| `compat` | 特定 API/provider 的兼容行为 |

来源：`@earendil-works/pi-ai/dist/types.d.ts:637-655`。

Pi 的 `--list-models` 从 `ModelRuntime.getAvailable()` 读取目录，并直接显示 `contextWindow`、`maxTokens`、`reasoning` 和 `input.includes("image")`，不存在另一组由用户维护的能力开关。来源：`@earendil-works/pi-coding-agent/dist/cli/list-models.js:24-58`。

图片发送前，Pi 根据当前模型的 `input` 判断是否保留图片；不含 `"image"` 时会把用户图片和工具图片替换成文本占位符。来源：`@earendil-works/pi-ai/dist/api/transform-messages.js:1-30`。这解释了为什么底层多模态 API 本身可用，Pi 仍可能不发送图片。

### 1.2 内置 provider 已携带完整模型目录

`pi-ai` 在启动时注册内置 provider，每个 provider 公开自己的 models；OpenAI provider 直接加载生成后的 `OPENAI_MODELS`。来源：

- `@earendil-works/pi-ai/dist/providers/all.js:45-114`
- `@earendil-works/pi-ai/dist/providers/openai.js:5-13`
- `@earendil-works/pi-ai/dist/providers/openai.models.js:1-5`
- `@earendil-works/pi-ai/dist/models.generated.js:40-78`

Pi 官方文档也明确说明：模型目录随 Pi 发布，并可自动刷新、缓存到 `~/.pi/agent/models-store.json`；CLI 可用 `pi update --models` 更新。来源：

- `@earendil-works/pi-coding-agent/docs/providers.md:1-4`
- `@earendil-works/pi-coding-agent/README.md:97-100`
- `@earendil-works/pi-coding-agent/dist/core/models-store.js:16-44`

`ModelRuntime.create()` 先装载 `pi-ai` 的内置目录，再叠加远端目录和本地配置；没有 overlay 时会直接返回原始内置模型。来源：

- `@earendil-works/pi-coding-agent/dist/core/model-runtime.js:46-86`
- `@earendil-works/pi-coding-agent/dist/core/model-runtime.js:111-143`

Pi 的远端模型目录默认来自 `https://pi.dev/api/models/providers/{providerId}`，支持 ETag/Last-Modified 和四小时刷新间隔，返回的是完整模型对象，不等同于供应商的 OpenAI-compatible `/models`。来源：`@earendil-works/pi-coding-agent/dist/core/remote-catalog-provider.js:1-15`、`:39-113`。

本地直接读取 0.82.1 内置目录的结果也表明能力已经预配置，而且不能只按模型名猜测：

| 模型 | `reasoning` | `input` | `contextWindow` | `maxTokens` |
| --- | ---: | --- | ---: | ---: |
| OpenAI `gpt-4o` | false | text, image | 128000 | 16384 |
| OpenAI `gpt-5` | true | text, image | 400000 | 128000 |
| OpenAI `o3-mini` | true | text | 200000 | 100000 |

这些值来自执行 `getBuiltinModel()` 读取当前安装包，模型结构与生成目录的来源分别见 `@earendil-works/pi-ai/dist/providers/all.js:45-63` 和 `@earendil-works/pi-ai/dist/providers/openai.models.js:1-5`。

### 1.3 TUI 的 `/model` 负责选模型，不负责编辑能力

交互式 model selector 从 `ModelRuntime` 快照取可用模型，并刷新目录；选择器操作的是 provider/model，而不是修改 `reasoning`、`input` 或 context。来源：

- `@earendil-works/pi-coding-agent/dist/modes/interactive/components/model-selector.js:43-105`
- `@earendil-works/pi-coding-agent/dist/modes/interactive/components/model-selector.js:118-149`

RPC 的 `get_available_models` 同样返回当前运行时的模型目录。协议文档给出的返回类型是完整 `Model[]`，实现直接返回 `session.modelRuntime.getAvailable()`：

- `@earendil-works/pi-coding-agent/docs/rpc.md:259-277`
- `@earendil-works/pi-coding-agent/docs/rpc.md:1367-1386`
- `@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts:212-216`
- `@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:379-381`

注意：`rpc-client.d.ts` 中的便利类型 `ModelInfo` 比协议实际返回值窄，只声明了 `provider`、`id`、`contextWindow`、`reasoning`；但 RPC 协议、服务端类型和服务端实现均返回完整模型对象。Cortex 若直接消费 JSON 协议，可以读取 `input` 等完整字段；若复用该客户端类型，需要先修正类型声明。来源：`@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.d.ts:27-32`、`:109-111`，以及 `rpc-client.js:187-192`。

## 2. `registerProvider` 的继承与覆盖规则

这是当前故障的关键。

| 配置方式 | Pi 0.82.1 行为 |
| --- | --- |
| `registerProvider(id, { baseUrl, apiKey/headers })`，不传 `models` | 保留该 provider 的已有模型目录，只覆盖 endpoint/认证 |
| `registerProvider(id, { models: [...] })` | 传入的数组替换该 provider 的全部已有模型 |
| `models.json` 中 `modelOverrides` | 对内置模型逐字段覆盖，未给字段继续继承 |
| `models.json` 中 `models` 定义同 ID 模型 | 构造一份新模型并 upsert；能力缺失时使用默认值，不从同 ID 内置模型继承 |
| 同一 extension 再次注册 | 顶层配置浅合并；新的 `models` 数组整体替换旧数组，不按模型字段深合并 |

官方 extension 文档明确给出“不传 models 保留现有模型”和“传 models 替换全部现有模型”的例子：

- `@earendil-works/pi-coding-agent/docs/custom-provider.md:93-120`
- `@earendil-works/pi-coding-agent/docs/custom-provider.md:160-184`

实现与文档一致：

- `applyExtension()` 在没有 `models` 时保留 base provider models；有 `models` 时返回 extension models：`@earendil-works/pi-coding-agent/dist/core/provider-composer.js:108-131`
- compose 顺序是内置目录 → `models.json` → extension → `modelOverrides`：`@earendil-works/pi-coding-agent/dist/core/provider-composer.js:279-349`
- extension 重注册是顶层浅合并：`@earendil-works/pi-coding-agent/dist/core/model-runtime.js:395-429`
- native provider 与同 ID 内置 provider 的选择规则：`@earendil-works/pi-coding-agent/dist/core/model-runtime.js:111-126`、`:386-393`

`models.json` 的默认能力是 `reasoning: false`、`input: ["text"]`、`contextWindow: 128000`、`maxTokens: 16384`。来源：

- `@earendil-works/pi-coding-agent/docs/models.md:197-210`
- `@earendil-works/pi-coding-agent/dist/core/provider-composer.js:45-73`

`modelOverrides` 才是保留内置模型并只改若干字段的机制。来源：

- `@earendil-works/pi-coding-agent/docs/models.md:318-366`
- `@earendil-works/pi-coding-agent/dist/core/provider-composer.js:22-43`

## 3. Cortex 当前为何覆盖了正确能力

当前 provider profile 把 `contextTokens`、`reasoning`、`vision` 存成用户可编辑模型属性。来源：`apps/desktop/src/main/ipc/types.ts:193-208`。

生成 Pi extension 时，Cortex 始终传入 `models`，并对没有显式填写的字段使用：

```text
reasoning: false
input: ["text"]
contextWindow: 131072
maxTokens: 8192
```

来源：`apps/desktop/src/main/agents/pi-providers.ts:49-73`。

根据上一节的规则，只要传了 `models`，这就不是对内置模型的小幅补充，而是替换整个 provider 的模型目录。所有未复制的 `thinkingLevelMap`、真实 context/output 限制、API-specific `compat` 等也一并丢失。

主任务针对当前打包的 `apps/desktop/resources/pi/pi` 0.82.1 做了同二进制差分验证：

| 场景 | 模型 | context | max output | thinking | images |
| --- | --- | ---: | ---: | --- | --- |
| 裸 Pi 内置目录，`OPENAI_API_KEY=test-only-key ... --list-models gpt-5.5` | `gpt-5.5` | 272K | 128K | yes | yes |
| 裸 Pi 内置目录，`DEEPSEEK_API_KEY=test-only-key ... --list-models deepseek-v4` | `deepseek-v4` | 1M | 384K | yes | no |
| 加载 Cortex 生成的 `~/Library/Application Support/Cortex/pi-providers/deepseek.js` | 同一 DeepSeek 模型 | 131.1K | 8.2K | no | no |

这组差分证明故障不是只丢失 `vision`：Cortex extension 替换了整份模型元数据，context、最大输出、推理和图片能力同时被简化。

设置页目前也把推理和视觉呈现为 checkbox，并把选中值写回 profile；模型列表再以 badge 显示这些用户选择。来源：

- `packages/views/cortex-desktop/personal/settings/ProviderManagerModal.tsx:85-99`
- `packages/views/cortex-desktop/personal/settings/ProviderManagerModal.tsx:133-138`
- `packages/views/cortex-desktop/personal/settings/ProviderManagerModal.tsx:248-250`

这与 Pi 的数据模型相反：这些字段应由 provider/model catalog 提供，UI 至多只读展示来源和能力。

## 4. 为什么不能只调用供应商 `/models` 自动识别

Cortex 当前 endpoint probe 支持多个 `/models` URL，但解析器只提取 `id`，结果类型也是 `models?: string[]`：

- `apps/desktop/src/main/ipc/provider.ts:22-63`
- `apps/desktop/src/main/ipc/provider.ts:79-109`
- `apps/desktop/src/main/ipc/types.ts:224-228`

即使保留供应商返回的全部字段，标准 OpenAI `/models` 也不提供视觉、推理、上下文或最大输出能力。当前安装的 OpenAI 官方 TypeScript SDK 6.26.0 将 list model 定义为 `id`、`created`、`object`、`owned_by`：

- `node_modules/.pnpm/openai@6.26.0_ws@8.21.0_zod@4.4.3/node_modules/openai/package.json:1-10`
- `node_modules/.pnpm/openai@6.26.0_ws@8.21.0_zod@4.4.3/node_modules/openai/src/resources/models.ts:9-27`
- `node_modules/.pnpm/openai@6.26.0_ws@8.21.0_zod@4.4.3/node_modules/openai/src/resources/models.ts:41-64`

Pi 的动态 provider 示例允许某些非标准服务额外返回 `context_window`、`max_tokens`，但仍由 extension 作者明确写入 `reasoning: false` 和 `input: ["text"]`，说明 `/models` 并不存在跨 provider 的统一能力合同。来源：`@earendil-works/pi-coding-agent/docs/custom-provider.md:121-158`。

因此要区分三个接口：

| 接口 | 能得到什么 | 用途 |
| --- | --- | --- |
| 供应商 OpenAI-compatible `/models` | 标准情况下只有模型 ID 等基本信息 | 发现可用 ID |
| Pi `pi.dev` provider catalog | Pi 定义的完整 `Model` 元数据 | 更新/补充 Pi 已知模型能力 |
| Pi RPC `get_available_models` | 当前进程 compose 完成后的完整目录 | 运行时校验和 UI 只读展示 |

RPC 不能自动修复一份已经被 Cortex 简化 extension 覆盖的目录；它只会忠实返回覆盖后的错误结果。

## 5. 建议的 Cortex 自动配置方案

### 5.1 数据原则

把能力改为系统管理、带来源的 route metadata，而不是用户 preference：

```ts
type ModelCapabilities = {
  status: "known" | "unknown";
  source:
    | "pi_builtin"
    | "pi_remote_catalog"
    | "provider_metadata"
    | "manual_override";
  catalogVersion?: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string>;
  contextWindow?: number;
  maxTokens?: number;
  compat?: unknown;
};
```

能力解析键应至少是：

```text
canonicalProviderId + modelId + endpointFormat
```

不能只按 `modelId` 匹配：同名模型可能经 OpenAI、OpenRouter 或厂商代理暴露，其 API adapter、推理参数和 `compat` 不同。

`unknown` 必须是独立状态，不能用 `false` 代替。否则“目录不知道”会再次变成“Pi 明确判定不支持”，并在发送前静默移除图片。

### 5.2 已知 Pi 原生 provider

在 Cortex preset/profile 中增加稳定的 `piProviderId`，不要从显示名称猜。

当 endpoint format 与 Pi 内置 provider 的协议一致时，extension 只覆盖 endpoint 和认证，不传 `models`：

```ts
pi.registerProvider("openai", {
  baseUrl: configuredBaseUrl,
  apiKey: configuredApiKey,
});
```

这是 Pi 官方支持的保留模型目录方式。模型可选范围继续由 Cortex 自己的 UI/profile 控制；即使 Pi runtime 暴露该 provider 的全部内置模型，也不需要为了“过滤列表”而销毁元数据。

### 5.3 已知模型，但经过代理或不同 API 协议

如果 route 必须注册为自定义 provider，或实际 endpoint format 与 Pi 内置 provider 不同，则为每个模型复制完整的受信目录元数据，再只改 route 必需字段。

建议 Cortex 显式直接依赖与 coding-agent 同版本的 `@earendil-works/pi-ai@0.82.1`，从 `@earendil-works/pi-ai/providers/all` 读取内置目录。不要依赖 pnpm 恰好提升出的传递依赖；显式锁同版本也便于 Electron 打包与升级审计。

需要分别处理：

- `input`、`reasoning`、`thinkingLevelMap`、`contextWindow`、`maxTokens` 可作为能力基线；
- `api` 必须按真实 endpoint format 设置；
- `compat` 可能是 API/provider-specific，不能在 `openai-responses` 与 `openai-completions` 之间盲目复制；
- provider 代理可能不转发某些推理参数，因此最终能力属于“route + model”，不是抽象模型名称的永恒属性。

Pi RPC `get_available_models` 可作为注册后的 round-trip 验证：断言目标模型仍含预期 `input`、reasoning 和 token limits。它适合作为验收与诊断接口，不是未知 custom provider 的原始事实来源。

### 5.4 未知自定义 endpoint/model

标准 `/models` 不足以可靠推导能力。可接受来源只有：

1. Cortex 维护的、版本化的 provider/model 能力清单；
2. Pi 完整 provider catalog；
3. 供应商提供且 Cortex 明确适配过的能力 metadata；
4. 高级管理入口的显式 override，并标注来源。

主动发送一张测试图片也不适合作为唯一判断：它会产生费用和副作用，认证、限流、代理转换、内容策略等错误都可能被误判为“不支持图片”。

在能力未知时，上传图片应给出明确提示并阻止本次发送，或者要求管理员补齐受信 manifest；不能静默省略图片后继续执行。

### 5.5 UI 与迁移

- 移除普通用户的“推理模型”“支持视觉”checkbox 和 context 手填项。
- 以只读 badge 展示 Pi/Cortex 解析出的能力，并显示来源与最后更新时间。
- 迁移现有 profile 时，优先按 `piProviderId + modelId + endpointFormat` 重新解析；不要继续把旧 checkbox 当作真实能力。
- 尚未覆盖的自定义模型迁移为 `unknown`，而不是默认 `text-only`。
- 如需保留人工修正，仅放在高级管理配置中，命名为 override，并明确其优先级和风险。

## 6. 建议验收标准

1. 相同 Pi 0.82.1 二进制下，加载 Cortex provider extension 前后，已知模型的 `reasoning`、`input`、`contextWindow`、`maxTokens` 不应变化；只允许 endpoint/认证/必要的 API adapter 变化。
2. 对原生 OpenAI provider，注册配置不含 `models`，`get_available_models` 中多模态模型仍有 `input: ["text", "image"]`。
3. 对代理 provider，注册后的 RPC 模型对象与解析器输出逐字段一致，尤其检查 `thinkingLevelMap` 和 `compat` 没有意外丢失。
4. 使用已知视觉模型发送图片时，Pi 不产生 `(image omitted: model does not support images)`。
5. 使用明确 text-only 模型时，UI 在发送前给出可解释错误；不能让任务在图片已被替换后继续。
6. 未知 custom model 显示 `unknown`，不能自动显示“不支持视觉/不支持推理”。
7. 更新 Pi 版本时，对内置目录做快照差分，发现 model ID、capability、context、max output 或 API adapter 变化后再更新 Cortex resolver。

## 最终判断

用户的判断是对的：模型能力应已经配置好，而不是让用户选择。Pi 0.82.1 已提供这层配置；Cortex 当前是在 extension 生成阶段把它覆盖掉了。

最小正确方向是：已知原生 provider 注册时不传 `models`；确需自定义模型列表时，从 Pi/Cortex 的受信目录生成完整模型对象；把设置页能力开关改为只读结果。供应商 `/models` 只负责发现 ID，不能承担通用能力识别。
