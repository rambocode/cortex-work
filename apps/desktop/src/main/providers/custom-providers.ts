// 自定义 Provider 定义：完整 Pi Provider JSON 的落盘、校验与 Secret 引用检查。
//
// ── 为什么存「整段 JSON 文本」而不是结构化字段 ─────────────────────────────────
// 旧实现把用户输入拆成 baseUrl/apiKey/models[{id,name}]，缺失字段用
// `reasoning:false / input:["text"] / 131072 / 8192` 猜测补齐 —— 那正是本次能力事故的形态。
// 现在原样保存用户给的 Pi Provider JSON：字段由 pi 的 schema 定义，Cortex 只做校验不做补全，
// 缺字段一律拒绝保存并给行级错误（计划 §2.2 / §4.2）。
//
// ── 明文 Secret 禁令 ─────────────────────────────────────────────────────────
// 这段 JSON 会落盘并被渲染成 pi extension 文件，所以敏感值（apiKey、Authorization 等 Header）
// **禁止**内嵌明文，只能写 `${secret:NAME}` 引用；真值经 `providerAuth:setSecrets` 进 safeStorage。
// 也允许 pi 自己的 `$ENV_VAR` 插值与 `!command`：这两种形态本身不含密钥。

import { promises as fsp } from "fs";
import { join } from "path";

import { cortexHome } from "../paths";
import { createLogger } from "../log";
import { safeId } from "../agents/pi-providers";
import type { CustomProviderDefinition, CustomProviderValidation } from "./contract";
import {
  SECRET_NAME_RE,
  collectSecretRefs,
  findUndefinedSecretRefs,
  isAllowedSensitiveValue,
  isSensitiveFieldName,
} from "./secrets";

const log = createLogger("provider-custom");

const STORE_FILE = "provider-custom.json";

/** pi 已知的流式 API 类型（pi-ai/dist/types.d.ts:15 的 KnownApi 逐字镜像）。 */
const KNOWN_APIS = new Set([
  "openai-completions",
  "mistral-conversations",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "pi-messages",
]);

/** Provider id：pi 用它做 provider 名，必须是无空格的 slug。 */
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

type ValidationError = { line?: number; message: string };

export function customProvidersPath(): string {
  return join(cortexHome(), STORE_FILE);
}

// ── 行号定位 ─────────────────────────────────────────────────────────────────

/**
 * 把「JSON 里的某个键/值」映射回编辑器行号。
 *
 * 刻意是**朴素文本查找**而非带位置信息的 JSON 解析器：错误提示只需把用户带到大致那一行，
 * 为此引入一个 CST 解析器不值当。找不到时返回 undefined，UI 退化成无行号的整体错误。
 */
function lineOf(text: string, needle: string, fromIndex = 0): number | undefined {
  const idx = text.indexOf(needle, fromIndex);
  if (idx < 0) return undefined;
  return text.slice(0, idx).split("\n").length;
}

/**
 * 从 JSON.parse 的 SyntaxError 里取行号。
 *
 * V8 的文案随版本变化：新版直接给 `(line N column M)`，多数情况给 `at position N`，
 * 少数「Unexpected token 'X', …」形态两者都没有。三种都要兼容，取不到就退化成无行号
 *（UI 仍会显示原始语法错误文案，只是不高亮具体行）。
 */
function lineOfParseError(text: string, err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : "";
  const byLine = /\bline\s+(\d+)/i.exec(message);
  if (byLine?.[1]) return Number(byLine[1]);
  const byPosition = /position\s+(\d+)/i.exec(message);
  if (byPosition?.[1]) return text.slice(0, Number(byPosition[1])).split("\n").length;
  return undefined;
}

// ── 校验 ─────────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// headers 里的键名就是 HTTP Header 名（Authorization / X-Api-Key / X-Corp-Auth…），
// 判定要比通用字段名更宽：任何带 auth/key/token/secret 的 Header 都视为敏感。
const SENSITIVE_HEADER_RE = /auth|key|token|secret|credential/i;

/** 递归检查敏感字段值：命中敏感键名却写了字面量 → 明文内嵌，拒绝。 */
function checkInlineSecrets(node: unknown, text: string, errors: ValidationError[], path: string[] = []): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => checkInlineSecrets(item, text, errors, [...path, String(i)]));
    return;
  }
  if (!isPlainObject(node)) return;
  // `compat` 是 pi 自己的**协议行为开关**（provider/API 特定），Cortex 只原样搬运，
  // 里面永远不会有凭据。必须整棵跳过，否则 `isSensitiveFieldName` 的 `includes("token")`
  // 会把 `maxTokensField`（目录里 93 个模型都有，取值恒为 "max_tokens"）误判成明文密钥，
  // 于是**恰恰是最需要这个开关的那批模型**保存不进去 —— 实测过的真实故障。
  // 同类还有 `supportsToolSearch` 等，都是「关于 token 计数/工具」而非「认证 token」。
  if (path.at(-1) === "compat") return;
  const insideHeaders = path.at(-1) === "headers";
  for (const [key, value] of Object.entries(node)) {
    const sensitive = insideHeaders ? SENSITIVE_HEADER_RE.test(key) : isSensitiveFieldName(key);
    if (sensitive && typeof value === "string" && !isAllowedSensitiveValue(value)) {
      errors.push({
        line: lineOf(text, `"${key}"`),
        message: `敏感字段 "${key}" 不得内嵌明文，请改用 \${secret:NAME} 引用（值经「Secret 管理」写入系统密钥库）`,
      });
      continue;
    }
    checkInlineSecrets(value, text, errors, [...path, key]);
  }
}

/** 模型对象在原文里的大致区间（由调用方按各模型 id 的出现位置切出）。 */
interface ModelRegion {
  start: number;
  end: number;
}

/** 校验单个模型对象。缺任何必填字段都拒绝——不猜默认值是本次修复的核心约束。 */
function validateModel(
  model: unknown,
  index: number,
  text: string,
  providerApi: unknown,
  region: ModelRegion,
  errors: ValidationError[],
): void {
  if (!isPlainObject(model)) {
    errors.push({ message: `models[${index}] 必须是对象` });
    return;
  }
  const label = typeof model.id === "string" ? model.id : `#${index}`;
  // 行号只在**本模型区间内**找，找不到（字段整个缺失）就退回到该模型的起始行。
  // 否则多模型时，缺字段的错误会指向前一个模型里那个同名键，指错地方比不指还糟。
  const at = (key: string): number | undefined => {
    const idx = text.indexOf(`"${key}"`, region.start);
    if (idx >= 0 && idx < region.end) return text.slice(0, idx).split("\n").length;
    return text.slice(0, region.start).split("\n").length;
  };
  const require = (key: string, ok: boolean, hint: string): void => {
    if (!ok) errors.push({ line: at(key), message: `models[${label}].${key} ${hint}` });
  };

  require("id", typeof model.id === "string" && model.id.length > 0, "必填，且须为非空字符串");
  require("name", typeof model.name === "string" && model.name.length > 0, "必填，且须为非空字符串");
  require("reasoning", typeof model.reasoning === "boolean", "必填，且须为布尔值（是否支持推理）");
  require(
    "input",
    Array.isArray(model.input) &&
      model.input.length > 0 &&
      model.input.every((item) => item === "text" || item === "image"),
    '必填，且只能包含 "text" / "image"',
  );
  require("contextWindow", typeof model.contextWindow === "number" && model.contextWindow > 0, "必填，且须为正数");
  require("maxTokens", typeof model.maxTokens === "number" && model.maxTokens > 0, "必填，且须为正数");

  const cost = model.cost;
  const costOk =
    isPlainObject(cost) &&
    (["input", "output", "cacheRead", "cacheWrite"] as const).every((key) => typeof cost[key] === "number");
  require("cost", costOk, "必填，须含 input/output/cacheRead/cacheWrite 四个数值（每百万 token 单价）");

  const api = model.api ?? providerApi;
  if (typeof api !== "string" || !api) {
    errors.push({ line: at("api"), message: `models[${label}].api 缺失：provider 或 model 层至少要指定一个 api` });
  } else if (!KNOWN_APIS.has(api)) {
    errors.push({
      line: at("api"),
      message: `models[${label}].api "${api}" 不是 pi 已知的流式 API（可选：${[...KNOWN_APIS].join(" / ")}）`,
    });
  }
}

/**
 * 校验一段自定义 Provider JSON。
 * `definedSecretNames` 传当前金库里已定义的 Secret 名；未定义的引用一律拒绝保存。
 */
export function validateCustomProviderJson(
  text: string,
  definedSecretNames: readonly string[],
): CustomProviderValidation {
  const errors: ValidationError[] = [];

  if (!text.trim()) return { ok: false, errors: [{ message: "内容为空" }] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      errors: [{ line: lineOfParseError(text, err), message: `JSON 语法错误：${(err as Error).message}` }],
    };
  }

  if (!isPlainObject(parsed)) return { ok: false, errors: [{ message: "顶层必须是一个 JSON 对象" }] };

  if (parsed.id !== undefined && (typeof parsed.id !== "string" || !PROVIDER_ID_RE.test(parsed.id))) {
    errors.push({ line: lineOf(text, '"id"'), message: "id 须是无空格的 slug（字母开头，可含数字、下划线、连字符）" });
  }

  const models = parsed.models;
  const hasModels = Array.isArray(models) && models.length > 0;

  if (hasModels) {
    // 定义模型时 baseUrl 必填（pi docs/custom-provider.md「Config Reference」）。
    if (typeof parsed.baseUrl !== "string" || !/^https?:\/\//i.test(parsed.baseUrl)) {
      errors.push({ line: lineOf(text, '"baseUrl"'), message: "baseUrl 必填，且须是 http(s) 地址" });
    }
    // 先按各模型 id 的出现位置切出区间，再逐个校验——错误行号才能落进对应的模型对象。
    const starts = models.map((model) =>
      isPlainObject(model) && typeof model.id === "string" ? text.indexOf(`"${model.id}"`) : -1,
    );
    models.forEach((model, i) => {
      const start = Math.max(0, starts[i] ?? -1);
      const end = starts.slice(i + 1).find((value) => value > start) ?? text.length;
      validateModel(model, i, text, parsed.api, { start, end }, errors);
    });
  } else if (Array.isArray(models)) {
    errors.push({ line: lineOf(text, '"models"'), message: "models 为空：自定义 Provider 必须至少声明一个模型" });
  } else {
    errors.push({ message: "缺少 models：自定义 Provider 必须声明完整的模型列表（字段不足会被拒绝，不做默认值猜测）" });
  }

  checkInlineSecrets(parsed, text, errors);

  for (const name of collectSecretRefs(text)) {
    if (!SECRET_NAME_RE.test(name)) {
      errors.push({ line: lineOf(text, `\${secret:${name}}`), message: `Secret 名 "${name}" 非法` });
    }
  }
  for (const name of findUndefinedSecretRefs(text, definedSecretNames)) {
    errors.push({
      line: lineOf(text, `\${secret:${name}}`),
      message: `引用了未定义的 Secret "${name}"，请先在「Secret 管理」里填写它的值`,
    });
  }

  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

// ── 落盘 ─────────────────────────────────────────────────────────────────────

interface CustomProviderFile {
  version: 1;
  providers: CustomProviderDefinition[];
}

let cache: CustomProviderFile | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function load(): Promise<CustomProviderFile> {
  if (cache) return cache;
  try {
    const raw = await fsp.readFile(customProvidersPath(), "utf8");
    const parsed = JSON.parse(raw) as CustomProviderFile;
    if (parsed?.version === 1 && Array.isArray(parsed.providers)) {
      cache = parsed;
      return cache;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.warn("自定义 Provider 文件读取失败，按空列表处理:", (err as Error)?.message);
    }
  }
  cache = { version: 1, providers: [] };
  return cache;
}

/** 串行落盘（同 ipc/store.ts 的 writeQueue 做法），避免并发保存互相覆盖。 */
function persist(next: CustomProviderFile): Promise<void> {
  cache = next;
  writeQueue = writeQueue
    .then(async () => {
      const path = customProvidersPath();
      await fsp.mkdir(cortexHome(), { recursive: true });
      const tmp = `${path}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
      await fsp.rename(tmp, path);
    })
    .catch((err) => {
      log.error("自定义 Provider 落盘失败:", (err as Error)?.message);
    });
  return writeQueue;
}

export async function listCustomProviders(): Promise<CustomProviderDefinition[]> {
  return [...(await load()).providers];
}

/**
 * 保存（新增或覆盖同 id）。校验不通过直接拒绝，绝不落一个 pi 加载不了的定义。
 *
 * `builtinIds` 是内建 Catalog 的 id 集合（由 IPC 层供给；本模块刻意不 import catalog.ts——
 * 它依赖 electron.app，会污染本文件的纯 Node 单测环境）。撞名必须在保存时就拒绝：
 * 同步侧（custom-provider-registry）对撞名定义是**静默丢弃**，probe/聊天会命中内建供应商的
 * 官方端点（其中不少是 coding-plan 专属端点），拿用户的 key 打过去返回 InvalidSubscription
 * 类 400，而设置页还显示着用户自己的 baseUrl——0.1.63 用户报障的正是这种假象。
 * 比对必须用 `safeId` 归一口径（PROVIDER_ID_RE 放行大写，"DeepSeek" 归一后即撞 "deepseek"），
 * 与 custom-provider-registry 的丢弃判据保持同一算法。
 * Catalog 不可用时调用方传 undefined → 跳过撞名检查（不能把一次目录加载失败放大成拒绝一切保存）。
 */
export async function saveCustomProvider(
  input: CustomProviderDefinition,
  definedSecretNames: readonly string[],
  builtinIds?: ReadonlySet<string>,
): Promise<{ ok: boolean; error?: string; errors?: ValidationError[] }> {
  if (!PROVIDER_ID_RE.test(input.id)) {
    return { ok: false, error: "Provider id 须是无空格的 slug（字母开头，可含数字、下划线、连字符）" };
  }
  if (builtinIds?.has(safeId(input.id))) {
    return {
      ok: false,
      error: `「${input.id}」与内建供应商同名。同名定义不会生效（内建目录始终优先），请换一个名称，例如加上「-自建」后缀。`,
    };
  }
  const validation = validateCustomProviderJson(input.json, definedSecretNames);
  if (!validation.ok) {
    return { ok: false, error: validation.errors[0]?.message ?? "配置校验未通过", errors: validation.errors };
  }

  const current = await load();
  const definition: CustomProviderDefinition = {
    id: input.id,
    json: input.json,
    // secretRefs 由主进程从 JSON 重新扫出来，不信 renderer 传的值（否则可绕过未定义引用检查）。
    secretRefs: collectSecretRefs(input.json),
    updatedAt: Date.now(),
  };
  const providers = current.providers.filter((item) => item.id !== input.id);
  providers.push(definition);
  await persist({ version: 1, providers });
  return { ok: true };
}

/** 删除。不存在时也返回 ok（幂等）。 */
export async function deleteCustomProvider(id: string): Promise<{ ok: boolean }> {
  const current = await load();
  if (!current.providers.some((item) => item.id === id)) return { ok: true };
  await persist({ version: 1, providers: current.providers.filter((item) => item.id !== id) });
  return { ok: true };
}

/** 单测用：清进程内镜像。 */
export function resetCustomProvidersForTests(): void {
  cache = null;
  writeQueue = Promise.resolve();
}
