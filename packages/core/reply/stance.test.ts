// 立场标记行解析的行为契约测试（协议见 stance.ts 文件头）。

import { describe, expect, it } from "vitest";
import { REPLY_STANCE_LABELS, parseStanceLine } from "./stance";

describe("parseStanceLine", () => {
  it("解析三档立场标记并返回剩余正文", () => {
    expect(parseStanceLine("[stance:agree]\n好，这块我们来承接。")).toEqual({
      stance: "agree",
      body: "好，这块我们来承接。",
    });
    expect(parseStanceLine("[stance:reject]\n这个暂时接不了。").stance).toBe("reject");
    expect(parseStanceLine("[stance:unsure]\n量级大概多少？").stance).toBe("unsure");
  });

  it("none 归一为 null（非决策点）", () => {
    const parsed = parseStanceLine("[stance:none]\n哈哈好的");
    expect(parsed.stance).toBeNull();
    expect(parsed.body).toBe("哈哈好的");
  });

  it("标记缺失 → 宽松降级：stance null、正文原样", () => {
    const parsed = parseStanceLine("直接就是正文，没有标记行");
    expect(parsed.stance).toBeNull();
    expect(parsed.body).toBe("直接就是正文，没有标记行");
  });

  it("容错：大小写 / 全角冒号 / 括号内外空白 / 前置空白", () => {
    expect(parseStanceLine("  [ Stance： AGREE ]  \n嗯行").stance).toBe("agree");
    expect(parseStanceLine("[STANCE:REJECT]不行").body).toBe("不行");
  });

  it("缩写标记（无 stance: 前缀）也可解析——实测模型常输出 [none] / [agree]", () => {
    expect(parseStanceLine("[none]\n没其他要求。")).toEqual({
      stance: null,
      body: "没其他要求。",
    });
    expect(parseStanceLine("[agree]\n好，接了。").stance).toBe("agree");
    expect(parseStanceLine("[REJECT]\n接不了。").stance).toBe("reject");
  });

  it("中文标记容错：[同意]/[拒绝]/[不确定]/[无]，全角方括号亦可", () => {
    expect(parseStanceLine("【同意】\n好，接了。")).toEqual({ stance: "agree", body: "好，接了。" });
    expect(parseStanceLine("【none】\n哈哈").stance).toBeNull();
    expect(parseStanceLine("[同意]\n好，接了。").stance).toBe("agree");
    expect(parseStanceLine("[拒绝]\n接不了。").stance).toBe("reject");
    expect(parseStanceLine("[不确定]\n量级多少？").stance).toBe("unsure");
    expect(parseStanceLine("[无]\n哈哈好的")).toEqual({ stance: null, body: "哈哈好的" });
  });

  it("协议外自造值：带 stance: 前缀一律剥掉——追问语义归入 unsure，未知值降级 null", () => {
    // 实测 bug：模型输出 [stance:question]，旧解析漏进正文首行
    expect(parseStanceLine("[stance:question]\n检查下代理端口是不是被占了。")).toEqual({
      stance: "unsure",
      body: "检查下代理端口是不是被占了。",
    });
    expect(parseStanceLine("[stance:accept]\n好。").stance).toBe("agree");
    expect(parseStanceLine("[stance:decline]\n不行。").stance).toBe("reject");
    // 完全未知的自造值：剥掉标记但不给 chip
    expect(parseStanceLine("[stance:whatever]\n好的。")).toEqual({ stance: null, body: "好的。" });
  });

  it("裸方括号英文别名可剥（[question]）；中文裸标记只认四个词（[抱拳] 表情不误剥）", () => {
    expect(parseStanceLine("[question]\n量级多少？").stance).toBe("unsure");
    const emoji = "[抱拳]谢谢老板";
    expect(parseStanceLine(emoji)).toEqual({ stance: null, body: emoji });
  });

  it("正文中间出现的同形片段不被误剥", () => {
    const text = "回复正文\n[stance:agree] 这行是正文的一部分";
    expect(parseStanceLine(text)).toEqual({ stance: null, body: text });
  });

  it("标记后无正文 → body 为空串（由调用方兜底空候选）", () => {
    expect(parseStanceLine("[stance:agree]")).toEqual({ stance: "agree", body: "" });
  });

  it("标签映射覆盖三档中文文案", () => {
    expect(REPLY_STANCE_LABELS).toEqual({ agree: "同意", reject: "拒绝", unsure: "不确定" });
  });
});
