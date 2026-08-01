// pi Provider Catalog 的 providerId 快照 fixture（供 media-provider-directory 测试用）。
//
// 来源：apps/desktop/resources/pi/provider-catalog.json（构建期由 scripts/build-pi-catalog.mjs
// 从锁定版本 @earendil-works/pi-ai 生成，运行库不进 git，故这里保留一份 id 快照）。
// 用途：目录里 kind="catalog" 的条目 id 必须存在于此集合——防止 pi 升级后 catalog id
// 漂移（改名/移除）而媒体目录悬空引用。pi 版本升级导致 id 集变化时同步更新本文件。
export const PI_PROVIDER_CATALOG_VERSION = "0.82.1";

export const PI_PROVIDER_CATALOG_IDS: readonly string[] = [
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure-openai-responses",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "together",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
];
