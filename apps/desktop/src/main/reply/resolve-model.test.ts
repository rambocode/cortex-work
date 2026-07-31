// reply 生成模型解析单测。
//
// 阶段③·4.1 收编后判据大幅收窄：可用性 / 认证 / 协议格式全部由 Pi Model Gateway 在出站前判
//（见 resolve-model.ts 文件头），这里只剩「按优先级挑出用户选的那个模型引用」。
// 因此原先关于 enabled / endpointFormat / models[0] 兜底的用例已不适用——**它们对应的行为
// 是被有意移除的**：endpointFormat 是旧直连时代的产物，而「取第一个模型」属于自动回退，
// 被计划 §5 明令禁止。

import { describe, expect, it } from "vitest";

import { resolveReplyModel } from "./resolve-model";

const FALLBACK = { providerId: "def", modelId: "dm" };

describe("resolveReplyModel 专属级优先", () => {
  it("reply 专属选择完整 → 直接用它，不看全局默认", () => {
    expect(resolveReplyModel({ providerId: "reply", model: "m2" }, FALLBACK)).toEqual({
      providerId: "reply",
      modelId: "m2",
    });
  });

  it("两段都被 trim（设置里手滑打的空格不该让引用失效）", () => {
    expect(resolveReplyModel({ providerId: "  reply  ", model: " m2 " }, null)).toEqual({
      providerId: "reply",
      modelId: "m2",
    });
  });
});

describe("resolveReplyModel 专属级不完整 → 落全局默认", () => {
  it("只有 providerId 没有 model → 整级作废（不猜该供应商的第一个模型）", () => {
    expect(resolveReplyModel({ providerId: "reply" }, FALLBACK)).toEqual(FALLBACK);
  });

  it("只有 model 没有 providerId → 同样整级作废（跨供应商套模型必然 404）", () => {
    expect(resolveReplyModel({ model: "m2" }, FALLBACK)).toEqual(FALLBACK);
  });

  it("全空白字符串等同缺失", () => {
    expect(resolveReplyModel({ providerId: "   ", model: "  " }, FALLBACK)).toEqual(FALLBACK);
  });

  it("settings 为 null（快照缺失）→ 直接用全局默认", () => {
    expect(resolveReplyModel(null, FALLBACK)).toEqual(FALLBACK);
  });
});

describe("resolveReplyModel 全缺失 → null（阻断态，不回退任何模型）", () => {
  it("两级都没有 → null", () => {
    expect(resolveReplyModel(null, null)).toBeNull();
    expect(resolveReplyModel(undefined, undefined)).toBeNull();
  });

  it("全局默认本身不完整（§5 清理后的常态）→ null", () => {
    expect(resolveReplyModel(null, { providerId: "def", modelId: "" })).toBeNull();
    expect(resolveReplyModel(null, { providerId: "", modelId: "dm" })).toBeNull();
  });
});
