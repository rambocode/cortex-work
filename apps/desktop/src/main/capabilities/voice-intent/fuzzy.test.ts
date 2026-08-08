import { describe, expect, it } from "vitest";

import { isFastPathVetoed, normalizeCommand } from "./commands";
import { matchCommandFuzzy } from "./fuzzy";

/** 正/负例表是拼音模糊匹配的行为契约：阈值或规则改动必须先过这张表。 */
describe("matchCommandFuzzy", () => {
  it("同音错字命中对应本地动作", () => {
    // ASR 同音字：拼音串精确相等（规则①）。
    expect(matchCommandFuzzy(normalizeCommand("腿下"))).toBe("exit_assistant");
    expect(matchCommandFuzzy(normalizeCommand("腿下吧"))).toBe("exit_assistant");
    expect(matchCommandFuzzy(normalizeCommand("新建对画"))).toBe("new_conversation");
    expect(matchCommandFuzzy(normalizeCommand("推出语音助手"))).toBe("exit_assistant");
    expect(matchCommandFuzzy(normalizeCommand("开起屏幕上下文"))).toBe("enable_screen_context");
  });

  it("近音单字替换命中（声母或韵母相同）", () => {
    // 「对发」dui fa vs「对话」dui hua：韵母不同、声母不同 → 不命中；
    // 「结束对花」jie shu dui hua 与「结束对话」同音 → 命中。
    expect(matchCommandFuzzy(normalizeCommand("结束对花"))).toBe("exit_assistant");
  });

  it("负例：语义无关或含正文的句子不得命中", () => {
    // 音节数不同：刻意不允许插入/删除（「推一下」与「退下」编辑距离恰为 1 的陷阱）。
    expect(matchCommandFuzzy(normalizeCommand("推一下"))).toBeNull();
    expect(matchCommandFuzzy(normalizeCommand("退下门帘"))).toBeNull();
    // 两处以上差异。
    expect(matchCommandFuzzy(normalizeCommand("你好"))).toBeNull();
    expect(matchCommandFuzzy(normalizeCommand("今天天气怎么样"))).toBeNull();
    // 非近音替换（声母韵母都不同）。
    expect(matchCommandFuzzy(normalizeCommand("退网"))).toBeNull();
  });
});

describe("isFastPathVetoed", () => {
  it("疑问/求助句硬否决，普通命令不受影响", () => {
    expect(isFastPathVetoed("怎么退出语音助手")).toBe(true);
    expect(isFastPathVetoed("如何新建对话")).toBe(true);
    expect(isFastPathVetoed("能不能退下")).toBe(true);
    expect(isFastPathVetoed("是退出了吗")).toBe(true);
    expect(isFastPathVetoed("退下吧")).toBe(false);
    expect(isFastPathVetoed("新建对话")).toBe(false);
  });
});
