// 静态检查：业务模块不得再硬编码 `/chat/completions`（计划 §4.1 最后一条）。
//
// 为什么用测试而不是 ESLint 规则：这条约束的本质是「全仓只允许有 0 处」，而不是「某种写法
// 不好」。用扫源码的测试表达最直接——它自带豁免清单与豁免**理由**，改动时能一眼看到为什么
// 某个路径被放行；写成自定义 lint 规则反而要另起一个包、理由散落在配置里。
//
// 为什么盯 `/chat/completions` 这一个字面量：收编前它是唯一的直连出口（openai-chat.ts →
// push-sign.ts 的 chatCompletionsUrl）。任何人再写出这个路径，都意味着绕过了 Pi Model
// Gateway，也就绕过了凭据金库、能力目录与 §5 的悬空引用阻断。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const MAIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 豁免清单。每条都必须写清**为什么它不算「业务模块直连」**。
 *
 * 音频（TTS/ASR）为什么可以留：pi 的 `Models` 只覆盖文本补全，没有 `/v1/audio/*` 的对应物。
 * 强行把音频也收编进 Gateway 会让整条 TTS/ASR 链路无端点可用。这是计划 §0 / §4.1 明确写下的
 * **排除项**，不是遗漏。（注意音频路径本来也不含 `/chat/completions`，列在这里是为了让
 * 「音频被有意豁免」这件事在代码里留痕，而不是靠计划文档口口相传。）
 */
const EXEMPTIONS: { path: string; reason: string }[] = [
  {
    path: "ipc/push-sign.ts",
    reason: "只剩音频端点拼接（audioSpeechUrl / audioTranscriptionsUrl / audioVoiceUrls）；文本侧的 chatCompletionsUrl 已随收编删除。",
  },
  {
    path: "capabilities/whisper",
    reason: "ASR 在线转写，走 /v1/audio/transcriptions —— 排除项。",
  },
  {
    path: "capabilities/media-gen",
    reason: "图/音/乐/视频生成，不进文本 Gateway —— 排除项。",
  },
  {
    path: "providers/no-direct-endpoint.test.ts",
    reason: "本文件自身要写出这个字面量才能检查它。",
  },
  {
    path: "ipc/openai-chat.ts",
    reason: "文件头注释在解释「收编前这里拼过这个路径」，属于历史说明而非活代码；下方另有断言钉住它不含 fetch 调用。",
  },
];

/** 递归收集 main 下的全部 .ts 源文件（相对 main 的 posix 风格路径）。 */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__fixtures__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSources(full, out);
    else if (entry.endsWith(".ts")) out.push(relative(MAIN_DIR, full).split(sep).join("/"));
  }
  return out;
}

const SOURCES = collectSources(MAIN_DIR);

function isExempt(file: string): string | undefined {
  return EXEMPTIONS.find((e) => file === e.path || file.startsWith(`${e.path}/`))?.reason;
}

describe("业务模块不再硬编码 /chat/completions", () => {
  it("扫到的源文件数量合理（防止遍历逻辑写歪导致空扫、假绿）", () => {
    expect(SOURCES.length).toBeGreaterThan(100);
  });

  it("除豁免路径外，main 下没有任何 /chat/completions 字面量", () => {
    const offenders = SOURCES.filter(
      (file) => !isExempt(file) && readFileSync(join(MAIN_DIR, file), "utf8").includes("/chat/completions"),
    );
    expect(offenders).toEqual([]);
  });

  it("豁免清单里的每条都仍然存在（路径改名后豁免不会静默失效）", () => {
    for (const { path } of EXEMPTIONS) {
      expect(SOURCES.some((file) => file === path || file.startsWith(`${path}/`))).toBe(true);
    }
  });

  it("音频端点被显式豁免且仍然可用（排除项没有被顺手收编）", () => {
    const pushSign = readFileSync(join(MAIN_DIR, "ipc/push-sign.ts"), "utf8");
    expect(pushSign).toContain("/audio/speech");
    expect(pushSign).toContain("/audio/transcriptions");
    // 反向：文本侧的旧出口必须已经消失，否则「拆分再删」只做了一半。
    expect(pushSign).not.toContain("chatCompletionsUrl");
  });

  it("openai-chat.ts 已不再自己发请求（只剩对 Gateway 的转调）", () => {
    const source = readFileSync(join(MAIN_DIR, "ipc/openai-chat.ts"), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).toContain("runGatewayComplete");
  });
});
