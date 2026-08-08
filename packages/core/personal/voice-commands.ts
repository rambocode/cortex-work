// 语音助手本地指令模板 —— 主进程（精确/拼音模糊匹配）与 renderer（未来语义匹配）共享的
// 单一事实源。纯数据常量，无副作用、无平台依赖，符合 core 分层约束。
//
// 参考 xiaozhi「简单指令离线、复杂任务在线」的分流思想：fast-path 只服务短小的本地
// 控制句；任何疑问、引用或复合任务都必须继续进入 Agent 聊天（fail-open）。

import type { VoiceAssistantIntentName } from "../desktop/types";

/** 一条本地动作与其表述变体集合；匹配层（精确/拼音/语义）各自决定如何消费 phrases。 */
export interface VoiceCommandTemplate {
  intent: Exclude<VoiceAssistantIntentName, "continue_chat">;
  /** 同一动作的表述变体（原文，未归一化；匹配层自行归一化）。 */
  phrases: readonly string[];
}

/** 全部本地指令模板。新增变体只改这里，主进程与 renderer 两端自动同步。 */
export const VOICE_COMMAND_TEMPLATES: readonly VoiceCommandTemplate[] = [
  {
    intent: "exit_assistant",
    phrases: [
      "退出",
      "关闭",
      "再见",
      "不聊了",
      "退下",
      "退下吧",
      "你退下吧",
      "可以退下了",
      "退出语音助手",
      "关闭语音助手",
      "结束对话",
      "结束语音助手",
    ],
  },
  {
    intent: "new_conversation",
    phrases: ["新建对话", "开始新对话", "新开一个对话", "换个新对话"],
  },
  {
    intent: "enable_screen_context",
    phrases: ["开启屏幕上下文", "打开屏幕上下文", "带上屏幕"],
  },
  {
    intent: "disable_screen_context",
    phrases: ["关闭屏幕上下文", "不要看屏幕", "不带屏幕"],
  },
];

/** 疑问/求助触发词硬否决表：命中任何一条的句子永不走 fast-path 模糊匹配。
 * 这是「怎么退出语音助手」必须进聊天而不能误执行退出的红线（对齐 xiaozhi 的
 * intent 提示词边界规则）；精确整句匹配不受此表影响——完整命令原文没有疑问词。 */
export const INTENT_VETO_PATTERNS: readonly RegExp[] = [
  /怎么|怎样|如何|为什么|为啥|什么意思|教我|是不是|能不能|可不可以/u,
  /[吗嘛呢]\s*[？?]?\s*$/u,
];

/** fast-path 只对短句启用：归一化后超过该长度的句子一律走原链路（长句几乎必然
 * 携带任务正文，模糊匹配误杀的代价远高于收益）。 */
export const FAST_PATH_MAX_CHARS = 10;
