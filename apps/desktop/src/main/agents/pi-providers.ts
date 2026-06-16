// 把用户配置的供应商（Provider）渲染成 pi extension（registerProvider）,供 pi `-e` 加载。
// pi 内置只认有限 provider,自定义 OpenAI 兼容端点（qwen/deepseek/kimi/本地/企业网关）
// 必须经 extension 注册。apiKey 不写进文件,用 $CORTEX_PI_KEY 占位,真实值由 cli.ts
// spawn 时经环境变量注入（文件 0600,且不落明文 key）。

import { app } from "electron";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// CliStartRequest.provider 的形状（主进程侧,避免依赖 core 包）。
export interface ProviderInput {
  id: string;
  baseUrl: string;
  apiKey?: string;
  models: { id: string; name?: string }[];
}

// spawn 时注入的环境变量名,与渲染出的 extension 中 apiKey 占位一致。
export const PI_KEY_ENV = "CORTEX_PI_KEY";

// 文件名/ provider 名安全化:仅保留字母数字与 - _,其余替换为 -。
// 导出供 buildArgs/buildRpcArgs 复用:`--provider` 必须与 registerProvider 的注册名同源,
// 否则 id 含空格/大写时选不中。
export function safeId(id: string): string {
  const s = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "provider";
}

// 渲染 extension 源码（纯函数,便于单测）。OpenAI 兼容默认值:
// reasoning 关、纯文本输入、cost 全 0（本地不做计费）、给宽松的上下文/输出上限。
export function renderPiExtension(provider: ProviderInput): string {
  const id = safeId(provider.id);
  const models = provider.models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
  }));
  return [
    "// 由 Cortex Desktop 自动生成,请勿手改。",
    "export default function (pi) {",
    `  pi.registerProvider(${JSON.stringify(id)}, {`,
    `    name: ${JSON.stringify(provider.id)},`,
    `    baseUrl: ${JSON.stringify(provider.baseUrl)},`,
    `    apiKey: ${JSON.stringify("$" + PI_KEY_ENV)},`,
    `    api: "openai-completions",`,
    `    models: ${JSON.stringify(models, null, 2).replace(/\n/g, "\n    ")},`,
    "  });",
    "}",
    "",
  ].join("\n");
}

// 写出 extension 文件,返回绝对路径。per-provider 一个文件,key 隔离清晰。
export function writePiExtension(provider: ProviderInput): string {
  const dir = join(app.getPath("userData"), "pi-providers");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${safeId(provider.id)}.js`);
  writeFileSync(file, renderPiExtension(provider), { mode: 0o600 });
  return file;
}
