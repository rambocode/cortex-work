import { describe, expect, it } from "vitest";

import {
  MEMORY_SCOPES,
  SAMPLE_LIMIT,
  appendSample,
  buildDistillPrompt,
  channelScopeForCapturedApp,
  cleanDistilledRules,
  composeUserProfile,
  emptyMemoryState,
  scopeChineseName,
  scopeFromChineseName,
  type MemoryState,
} from "./memory";

// MARK: - 分区枚举与中文名映射(源 memoryScopeChineseNameMappingIsComplete)

describe("MemoryScope", () => {
  it("枚举恰为 5 个分区", () => {
    expect(MEMORY_SCOPES.length).toBe(5);
  });

  it("中文名映射完整且可逆(UI 靠中文名寻址)", () => {
    for (const scope of MEMORY_SCOPES) {
      expect(scopeFromChineseName(scopeChineseName(scope))).toBe(scope);
    }
  });
});

// MARK: - 学习样本(源 memorySamplesAppendAndCapAtLimit / memorySamplesIgnoreBlankText)

describe("appendSample", () => {
  it("追加/读取,超过上限淘汰最旧的", () => {
    let samples: string[] = [];
    for (let index = 0; index < SAMPLE_LIMIT + 5; index += 1) {
      samples = appendSample(samples, `消息 ${index}`);
    }
    expect(samples.length).toBe(SAMPLE_LIMIT);
    expect(samples[0]).toBe("消息 5");
    expect(samples[samples.length - 1]).toBe(`消息 ${SAMPLE_LIMIT + 4}`);
  });

  it("空白样本被忽略", () => {
    const samples = appendSample([], "   \n");
    expect(samples.length).toBe(0);
  });

  it("是纯函数,不改入参", () => {
    const original = ["a"];
    const next = appendSample(original, "b");
    expect(original).toEqual(["a"]);
    expect(next).toEqual(["a", "b"]);
  });
});

// MARK: - 蒸馏 prompt(源 distillPromptIncludesSamplesAndExistingRules)

describe("buildDistillPrompt", () => {
  it("带上分区目标、已学规则与编号样本,并要求只输出要点", () => {
    const prompt = buildDistillPrompt("im", ["收到,晚点看", "OK 我来 follow up"], "- 短句为主");

    expect(prompt.system).toContain("IM 场景");
    expect(prompt.system).toContain("不超过 10 条");
    expect(prompt.user).toContain("已学到的规则：\n- 短句为主");
    expect(prompt.user).toContain("1. 收到,晚点看");
    expect(prompt.user).toContain("2. OK 我来 follow up");
  });

  it("无已学规则时不注入「已学到的规则」段", () => {
    const prompt = buildDistillPrompt("core", ["样本"], "");
    expect(prompt.user).not.toContain("已学到的规则");
    expect(prompt.user).toContain("1. 样本");
  });
});

// MARK: - 输出清洗(源 cleanDistilledRulesKeepsOnlyBulletLines)

describe("cleanDistilledRules", () => {
  it("过滤解释性文字,只留要点行", () => {
    const output = ["好的,总结如下：", "- 短句为主", "• 不用称呼", "以上就是全部规则。"].join(
      "\n",
    );
    expect(cleanDistilledRules(output)).toBe("- 短句为主\n• 不用称呼");
  });
});

// MARK: - composedProfile 注入规则(源 composedUserProfile / channelScopeForCapturedApp)

describe("channelScopeForCapturedApp", () => {
  it("邮件类应用归 email,其余归 im", () => {
    expect(channelScopeForCapturedApp({ bundleId: "com.apple.mail", name: "邮件" })).toBe("email");
    expect(channelScopeForCapturedApp({ bundleId: "com.tencent.xinWeChat", name: "微信" })).toBe(
      "im",
    );
    expect(channelScopeForCapturedApp({ name: "Gmail" })).toBe("email");
    expect(channelScopeForCapturedApp({})).toBe("im");
  });
});

describe("composeUserProfile", () => {
  const memory: MemoryState = {
    ...emptyMemoryState(),
    profile: { manual: "我是产品经理", auto: "" },
    core: { manual: "", auto: "- 短句为主" },
    im: { manual: "IM 手写规则", auto: "- IM 自动规则" },
    email: { manual: "邮件手写规则", auto: "" },
  };

  it("恒含 profile+core,按捕获应用注入 im(非邮件)", () => {
    const composed = composeUserProfile({
      userProfile: "基础档案",
      memory,
      capturedApp: { name: "微信" },
    });
    expect(composed).toContain("基础档案");
    expect(composed).toContain("我是产品经理");
    expect(composed).toContain("- 短句为主");
    // 注入 im 而非 email
    expect(composed).toContain("IM 手写规则");
    expect(composed).toContain("- IM 自动规则");
    expect(composed).not.toContain("邮件手写规则");
  });

  it("邮件应用注入 email 分区而非 im", () => {
    const composed = composeUserProfile({
      memory,
      capturedApp: { name: "Mail" },
    });
    expect(composed).toContain("邮件手写规则");
    expect(composed).not.toContain("IM 手写规则");
  });

  it("手写在前且标注最高优先级、冲突以此为准", () => {
    const composed = composeUserProfile({ memory, capturedApp: { name: "微信" } });
    const manualIndex = composed.indexOf("IM 手写规则");
    const autoIndex = composed.indexOf("- IM 自动规则");
    // 手写段出现在自动段之前
    expect(manualIndex).toBeGreaterThanOrEqual(0);
    expect(manualIndex).toBeLessThan(autoIndex);
    expect(composed).toContain("优先级最高");
    expect(composed).toContain("冲突时以此为准");
  });
});
