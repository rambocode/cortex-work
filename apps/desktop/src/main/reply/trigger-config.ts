// 快捷回复设置值 → Cortex_Helper events 协议配置。
//
// 该转换必须集中在主进程边界：renderer 保存的是面向用户的枚举（cmd / rightOption / none），
// Swift helper 接受的是 CGEventFlags 语义名。尤其是 none 必须显式转成 null；省略字段代表
// “沿用旧配置”，会造成设置页已清空但后台仍监听旧按键的裂脑。

import type { ReplySettings } from "../ipc/reply-types";
import type { HelperEventsConfig, ModifierName } from "./helper-client";

type ReplyTriggerSettings = Pick<ReplySettings, "draftTrigger" | "voiceTrigger">;

function toModifier(trigger: ReplyTriggerSettings[keyof ReplyTriggerSettings]): ModifierName | null {
  switch (trigger) {
    case "cmd": return "command";
    case "option":
    case "rightOption": return "option";
    case "fn": return "function";
    case "none": return null;
  }
}

/**
 * 构造 helper 的完整快捷回复手势配置。
 *
 * 旧档没有 replySettings 时沿用产品默认值：双击 Command 起草、按住 Fn 语音起草。
 * 返回值始终同时包含 draft 与 voice，避免局部配置意外保留 helper 中的历史值。
 */
export function buildReplyTriggerConfig(settings?: Partial<ReplyTriggerSettings>): Required<
  Pick<HelperEventsConfig, "draft" | "voice">
> {
  return {
    draft: toModifier(settings?.draftTrigger ?? "cmd"),
    voice: toModifier(settings?.voiceTrigger ?? "fn"),
  };
}
