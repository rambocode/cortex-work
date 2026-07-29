# Spike：pi 运行时改工具集（能否拆掉 extensionFingerprint 重开会话）

日期：2026-07-29 · pi 版本：0.82.1 · 状态：**结论已得，未排期实现**

## 背景

Cortex 当前最重的 pi 架构约束是**工具集在 `pi:open` 时冻结**：没有运行时改工具集的 RPC 命令，所以凡是影响工具集的设置改动都要靠 `extensionFingerprint` 漂移**重开整个会话**（丢上下文、冷启动 ~790ms）。受影响的场景：

- `--tools` 只读白名单（plan 运行档，`pi-rpc.ts` 的 `buildRpcArgs`）
- `webSearch` 开关（计入指纹，见 `packages/core/desktop/types.ts` 的 `extensionFingerprint` 注释）

pi 0.80.7 的「动态工具加载」宣称扩展可在运行过程中添加工具。本 spike 验证它在 **cortex 的实际集成形态**（spawn 自包含二进制 + `--mode rpc` + `-e` 文件扩展）下是否成立。

## 方法

对 `apps/desktop/resources/pi/pi` 直接起 `--mode rpc --no-extensions --no-skills -e probe-ext.js -a`，扩展注册 `/probe` 斜杠命令，在 handler 内依次探测并把结果经 `ctx.ui.notify` 吐回 host。**全程不跑 agent 轮次，因此不需要 LLM 凭据。**

脚本未进仓库（scratchpad 一次性验证）。

## 结论：成立

```
api-shape          : { piGetActive:"function", piSetActive:"function",
                       piGetAll:"function", piRefresh:"undefined",
                       ctxGetActive:"undefined" }
active-before      : ["read","bash","edit","write"]
all-before         : ["read","bash","edit","write","grep","find","ls"]
active-after-narrow: ["read","grep"]                                    ← setActiveTools 生效
all-after-register : [...,"spike_added_tool"]                           ← 运行时 registerTool 生效
active-after-add   : ["read","spike_added_tool"]                        ← 新工具可被激活
```

要点：

1. **API 在 `pi`（`ExtensionAPI`）对象上，不在 `ctx` 上。** `ctx.getActiveTools` 等一律 `undefined`——`ExtensionCommandContext` 虽 `extends ExtensionContext`，但这组工具 API 只挂在 `ExtensionAPI`。踩过一次，实现时直接用闭包里的 `pi`。
2. `pi.setActiveTools(names)` 可在会话运行中收窄激活集 —— **`--tools` 白名单场景完全对症**。
3. `pi.registerTool()` 可在会话运行中新增工具，且新工具能被 `setActiveTools` 激活 —— webSearch 这类「增工具」场景也有路可走。
4. `pi.refreshTools` **未暴露**（类型里有 `RefreshToolsHandler`，运行期是 `undefined`）。上面两条不依赖它。
5. 触发通道：斜杠命令 handler。Cortex 已有 `renderSlashCommandExtension` 先例，且本次升级新增的 `get_commands` 缓存会把它正确识别为 `source: "extension"`，不会误判成 agent 轮次。

## 未验证（排期前必须补）

- **模型是否真能调用运行时新增的工具** —— spike 只验证了 pi 内部工具表，没跑真实 LLM 轮次确认工具进了发给模型的 schema。
- **prompt cache 前缀是否被破坏** —— 工具表是 system 段的一部分，改它很可能让缓存前缀失效。需对照 `message_end.usage.cacheRead` 实测。这条直接决定收益：若每次改工具集都击穿缓存，那与重开会话的成本差距会大幅缩小。
- 收窄激活集后，**已在上下文里的历史工具调用**如何呈现给模型（是否报错/被过滤）。

## 排期建议

优先做 **`--tools` 白名单（plan 档切换）** 这一半：它只用 `setActiveTools`、不新增工具，改动面最小，且是用户最常触发的重开场景。webSearch 那半依赖 registerTool + MCP 桥接重建，复杂度高一个量级，等前半跑稳再说。

两半都要先补上面的缓存实测——如果缓存必然击穿，整件事的收益需要重新评估。

## 相关

- 现状约束：`packages/core/personal/pi-session.ts`、`packages/core/personal/messages.ts` 的 `extensionFingerprint`
- 扩展渲染：`apps/desktop/src/main/agents/pi-extensions.ts`
- 命令来源缓存：`apps/desktop/src/main/agents/pi-rpc.ts` 的 `loadSlashCommands`
