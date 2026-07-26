// 研究能力的准入闸：总开关 + 按 Consumer 的灰度开关。
//
// **单独成文件的理由**：这套判定有两个调用方——会话式的 ResearchService（create/run/resume）
// 与请求响应式的 QuickRetrieval（discover/prepare）。两份拷贝迟早会漂移，而漂移的后果是
// 「某条路径绕过了用户明确关掉的开关」，属于安全性问题而不只是不一致。
//
// 相关文件：开关字段定义见 core/research/settings；各 Consumer 的默认配置见 core/research/consumer。
import type { ResearchConsumer } from "@cortex-work/core/research/types";
import type { ResearchEngineSettings } from "@cortex-work/core/research/settings";

/// 功能未开启。IPC 层据此回一个明确的提示，而不是让用户看到一条底层报错。
export class ResearchDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchDisabledError";
  }
}

/// 搜索服务未配置。与"未开启"分开：前者要去设置页填地址或密钥，后者只需打开开关。
export class SearchServerNotConfiguredError extends Error {
  constructor() {
    super("尚未配置研究搜索服务，请在设置中填写自建服务地址或直连搜索密钥");
    this.name = "SearchServerNotConfiguredError";
  }
}

/// 各 Consumer 对应的灰度开关。coding / knowledge 暂无独立开关，跟随总开关（U9/U10 再拆）。
export const CONSUMER_SWITCHES: Partial<Record<ResearchConsumer, keyof ResearchEngineSettings>> = {
  chat: "chatEnabled",
  deep_research: "deepResearchEnabled",
  slides: "slidesEnabled",
  writing: "writingEnabled",
};

/// 总开关 + Consumer 灰度开关。两者都通过才允许发起研究，否则抛 ResearchDisabledError。
export function assertResearchEnabled(
  settings: ResearchEngineSettings,
  consumer: ResearchConsumer,
): void {
  if (!settings.enabled) {
    throw new ResearchDisabledError("研究引擎未开启，请在设置中启用");
  }
  const key = CONSUMER_SWITCHES[consumer];
  // `!== true` 而不是 `=== false`：缺失字段（旧配置）同样视为关闭。
  // 这些开关控制的是数据出站，缺省必须是保守的那一侧。
  if (key && settings[key] !== true) {
    throw new ResearchDisabledError(`该场景的研究能力未开启：${consumer}`);
  }
}
