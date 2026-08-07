# xiaozhi-server 语音意图识别调研

## 调研基线

- 上游仓库：`xinnan-tech/xiaozhi-esp32-server`
- 基线提交：`7475ea2b2db6825551daf7be18ab610b8a237cc3`
- 调研范围：`main/xiaozhi-server` 的 Intent 配置、意图入口、`intent_llm` 与主对话函数调用链。

## 一手源码结论

1. xiaozhi 将意图模式分成 `nointent`、`intent_llm` 和 `function_call`。配置注释明确指出：`intent_llm` 会增加串行延迟；`function_call` 依赖主 LLM 的工具调用能力，但按需调用、速度更快。因此默认选择 `function_call`。[config.yaml](https://github.com/xinnan-tech/xiaozhi-esp32-server/blob/7475ea2b2db6825551daf7be18ab610b8a237cc3/main/xiaozhi-server/config.yaml#L245-L275)
2. 所有模式之前都先做精确退出命令与唤醒词判断；进入 `function_call` 时不再额外调用意图模型，而是把原始文本交给主对话链。[intentHandler.py](https://github.com/xinnan-tech/xiaozhi-esp32-server/blob/7475ea2b2db6825551daf7be18ab610b8a237cc3/main/xiaozhi-server/core/handle/intentHandler.py#L20-L50)
3. `intent_llm` 使用严格 JSON 的函数语义：匹配函数则返回 `function_call`，否则返回 `continue_chat`。提示词特别防止把“怎么退出了”误判为退出，并要求只有明确退出指令才调用退出函数。[intent_llm.py](https://github.com/xinnan-tech/xiaozhi-esp32-server/blob/7475ea2b2db6825551daf7be18ab610b8a237cc3/main/xiaozhi-server/core/providers/intent/intent_llm/intent_llm.py#L62-L120)
4. 分类会参考最近四条对话；模型错误、调用失败或 JSON 解析失败都回退 `continue_chat`，不会吞掉普通对话。[intent_llm.py](https://github.com/xinnan-tech/xiaozhi-esp32-server/blob/7475ea2b2db6825551daf7be18ab610b8a237cc3/main/xiaozhi-server/core/providers/intent/intent_llm/intent_llm.py#L142-L167) [intent_llm.py](https://github.com/xinnan-tech/xiaozhi-esp32-server/blob/7475ea2b2db6825551daf7be18ab610b8a237cc3/main/xiaozhi-server/core/providers/intent/intent_llm/intent_llm.py#L197-L225) [intent_llm.py](https://github.com/xinnan-tech/xiaozhi-esp32-server/blob/7475ea2b2db6825551daf7be18ab610b8a237cc3/main/xiaozhi-server/core/providers/intent/intent_llm/intent_llm.py#L233-L296)
5. `function_call` 模式把已注册函数直接交给主 LLM 的流式接口，工具结果仍在同一对话轮内处理，而不是先做一遍独立分类。[connection.py](https://github.com/xinnan-tech/xiaozhi-esp32-server/blob/7475ea2b2db6825551daf7be18ab610b8a237cc3/main/xiaozhi-server/core/connection.py#L1091-L1139)

## Cortex Desktop 采用的映射

| xiaozhi 概念 | Cortex Desktop 实现 |
| --- | --- |
| 精确退出命令 | 在主进程意图模块中先做规范化后的整句匹配，避免额外模型延迟 |
| `function_call` | 默认模式；普通意图继续进入现有 Agent 发送管线，由 Agent 的 tools/MCP/skills 完成函数调用 |
| `intent_llm` | 可选串行分类器，仅负责语音助手本地生命周期动作，不代替 Agent 的通用工具理解 |
| `continue_chat` | 任何未知、超时、模型不可用或非法 JSON 都返回普通聊天，原转写文本不丢失 |
| 本地函数 | 退出语音助手、新建对话、开启/关闭屏幕上下文 |

## 有意保留的差异

- Cortex 已经把通用工具调用统一在 Agent 会话中，不能再复制一套插件注册表，否则同一工具会有两个权限和执行边界。
- 本期 `intent_llm` 只识别无参数或布尔型本地动作；包含任务正文的复合句一律 `continue_chat`，防止分类器截断用户任务。
- 意图模型使用 Provider Catalog 引用，密钥不进入 renderer；用户未配置专用模型时跟随全局默认模型。
