import { describe, expect, it } from "vitest";

import { createSentenceAssembler } from "./ttsSentenceStream";

describe("createSentenceAssembler", () => {
  it("跨 delta 的句边界：句子闭合才产出", () => {
    const asm = createSentenceAssembler();
    expect(asm.push("今天天气")).toEqual([]);
    expect(asm.push("不错。我们")).toEqual(["今天天气不错。"]);
    expect(asm.push("出去走走吧！")).toEqual(["我们出去走走吧！"]);
    expect(asm.flushTail()).toEqual([]);
  });

  it("首句 eager：未出过句时逗号即闭合（需满足最短长度），后续只认强终止符", () => {
    const asm = createSentenceAssembler();
    // 逗号前不足 8 字：不闭合。
    expect(asm.push("好的，")).toEqual([]);
    // 累计到 8 字以上后遇逗号：eager 闭合首句。
    expect(asm.push("我来帮你查一下，")).toEqual(["好的，我来帮你查一下，"]);
    // 已出过首句：后续逗号不再闭合，直到强终止符。
    expect(asm.push("稍等片刻，马上就好")).toEqual([]);
    expect(asm.push("。")).toEqual(["稍等片刻，马上就好。"]);
  });

  it("代码围栏跨多个 delta：整体替换为占位，不读半截代码", () => {
    const asm = createSentenceAssembler();
    expect(asm.push("可以这样写：`")).toEqual([]);
    expect(asm.push("``ts\nconst a = 1;\n``")).toEqual([]);
    expect(asm.push("`然后运行。")).toEqual(["可以这样写：（代码略）然后运行。"]);
  });

  it("流结束时未闭合的围栏按代码略处理", () => {
    const asm = createSentenceAssembler();
    asm.push("看这段```const x = 1;");
    expect(asm.flushTail()).toEqual(["看这段（代码略）"]);
  });

  it("累计 600 字上限：超限句子丢弃，flushTail 补省略提示", () => {
    const asm = createSentenceAssembler();
    const long = "字".repeat(299) + "。";
    expect(asm.push(long)).toHaveLength(1);
    expect(asm.push(long)).toHaveLength(1);
    // 已到 600：后续句子不再产出。
    expect(asm.push("这句读不到了。")).toEqual([]);
    expect(asm.flushTail()).toEqual(["……以下省略"]);
  });

  it("fedLength 无条件累计原始字符（尾差对齐依据）", () => {
    const asm = createSentenceAssembler();
    asm.push("你好。");
    asm.push("再见");
    expect(asm.fedLength()).toBe(5);
  });

  it("flushTail 把未闭合尾部作为最后一句；reset 后可复用", () => {
    const asm = createSentenceAssembler();
    expect(asm.push("最后一句没有标点")).toEqual([]);
    expect(asm.flushTail()).toEqual(["最后一句没有标点"]);
    asm.reset();
    expect(asm.fedLength()).toBe(0);
    expect(asm.push("重新开始。")).toEqual(["重新开始。"]);
  });
});
