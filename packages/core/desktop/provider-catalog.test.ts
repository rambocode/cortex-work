// 自定义 Provider JSON 的渲染端读取层：能力解析（parseCustomProvider）与
// 能力来源标注（readCapabilitySources）。两者都是纯函数，且都必须在**坏数据**面前保持诚实。
//
// 贯穿本文件的一条红线：`input` 缺失与 `input:["text"]` 语义不同 —— 前者是「不知道」，
// 后者是「明确不支持图片」。任何把前者兜底成后者的实现都会让图片被静默丢弃（2026-07-30 事故）。

import { describe, expect, it } from "vitest";

import {
  findCustomProviderModel,
  parseCustomProvider,
  readCapabilitySources,
  type CustomProviderDefinition,
} from "./provider-catalog";

function define(json: unknown, id = "corp-gw"): CustomProviderDefinition {
  return { id, json: typeof json === "string" ? json : JSON.stringify(json), secretRefs: [], updatedAt: 1 };
}

/** 一个能力字段齐备的模型条目。 */
function fullModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "gpt-4o",
    name: "GPT-4o",
    api: "openai-completions",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...overrides,
  };
}

describe("parseCustomProvider", () => {
  it("能力字段齐备的模型原样透出", () => {
    const parsed = parseCustomProvider(define({ name: "网关", baseUrl: "https://g/v1", models: [fullModel()] }));
    expect(parsed!.models).toHaveLength(1);
    expect(parsed!.models[0]).toMatchObject({ input: ["text", "image"], reasoning: true, contextWindow: 128_000 });
  });

  it.each([
    ["input 缺失", { input: undefined }],
    ["input 为空数组", { input: [] }],
    ["reasoning 缺失", { reasoning: undefined }],
    ["contextWindow 缺失", { contextWindow: undefined }],
    ["maxTokens 缺失", { maxTokens: undefined }],
    ["id 缺失", { id: undefined }],
  ])("%s → 整条模型丢弃，绝不补默认值（事故根因红线）", (_label, patch) => {
    const parsed = parseCustomProvider(
      define({ name: "网关", baseUrl: "https://g/v1", models: [fullModel(patch)] }),
    );
    // 宁可让模型不出现在选择器里，也不能给出一份猜出来的能力。
    expect(parsed!.models).toEqual([]);
  });

  it("input 里的非法模态被过滤，只保留 text / image", () => {
    const parsed = parseCustomProvider(
      define({ name: "网关", baseUrl: "https://g/v1", models: [fullModel({ input: ["text", "audio", "image"] })] }),
    );
    expect(parsed!.models[0]!.input).toEqual(["text", "image"]);
  });

  it("JSON 语法错误 / 顶层不是对象 → undefined（调用方按「配置不完整」展示）", () => {
    expect(parseCustomProvider(define("{ 坏 json"))).toBeUndefined();
    expect(parseCustomProvider(define("[]"))).toBeUndefined();
  });

  it("provider 名缺失时退回定义 id，不留空名", () => {
    const parsed = parseCustomProvider(define({ baseUrl: "https://g/v1", models: [] }, "corp-gw"));
    expect(parsed!.name).toBe("corp-gw");
  });

  it("auth 恒为空数组：自定义 Provider 不走内建凭据通道，据此被视为「天然可用」", () => {
    expect(parseCustomProvider(define({ models: [] }))!.auth).toEqual([]);
  });
});

describe("findCustomProviderModel", () => {
  const defs = [define({ name: "网关", baseUrl: "https://g/v1", models: [fullModel()] })];

  it("providerId + modelId 双键命中", () => {
    expect(findCustomProviderModel(defs, { providerId: "corp-gw", modelId: "gpt-4o" })).toMatchObject({
      contextWindow: 128_000,
    });
  });

  it("任一键不匹配 → undefined（同名模型经不同 Provider 能力不同，不许只按 modelId 找）", () => {
    expect(findCustomProviderModel(defs, { providerId: "other", modelId: "gpt-4o" })).toBeUndefined();
    expect(findCustomProviderModel(defs, { providerId: "corp-gw", modelId: "nope" })).toBeUndefined();
  });

  it("空列表 / 空引用 → undefined", () => {
    expect(findCustomProviderModel([], { providerId: "corp-gw", modelId: "gpt-4o" })).toBeUndefined();
    expect(findCustomProviderModel(defs, undefined)).toBeUndefined();
  });
});

describe("readCapabilitySources", () => {
  it("读出每个模型的来源标注，区分「目录命中」与「参照补全」", () => {
    const def = define({
      models: [
        fullModel({ capabilitySource: "openai/gpt-4o" }),
        fullModel({ id: "luna", capabilitySource: "reference:openai/gpt-4o" }),
      ],
    });
    expect(readCapabilitySources(def)).toEqual({
      "gpt-4o": "openai/gpt-4o",
      luna: "reference:openai/gpt-4o",
    });
  });

  it("手写 JSON / 旧定义没有这个字段 → 映射里就没有对应项，不编造来源", () => {
    // 「来源未记录」是一个诚实的状态，UI 据此不渲染标注；给它编一个来源等于伪造审计信息。
    expect(readCapabilitySources(define({ models: [fullModel()] }))).toEqual({});
  });

  it("空串来源被当作没有（避免渲染出一条空标注）", () => {
    expect(readCapabilitySources(define({ models: [fullModel({ capabilitySource: "" })] }))).toEqual({});
  });

  it("坏 JSON / models 不是数组 → 空映射，不抛错（只是少一条只读提示，不该拖垮设置页）", () => {
    expect(readCapabilitySources(define("{ 坏"))).toEqual({});
    expect(readCapabilitySources(define({ models: "nope" }))).toEqual({});
    expect(readCapabilitySources(define({}))).toEqual({});
  });

  it("能力字段不全、会被 parseCustomProvider 丢弃的模型，其来源标注也照常读出", () => {
    // 两者刻意解耦：来源标注是「关于能力的元数据」，不参与「这条模型能不能用」的判定。
    const def = define({ models: [{ id: "half", capabilitySource: "openai/gpt-4o" }] });
    expect(parseCustomProvider(def)!.models).toEqual([]);
    expect(readCapabilitySources(def)).toEqual({ half: "openai/gpt-4o" });
  });
});
