// 会话内证据段渲染的测试。
//
// 核心不变量：证据有自己的预算，**绝不挤占记忆的预算**——用户画像被一篇网页顶掉，
// 是比"资料少一点"严重得多的退化。
import { describe, expect, it } from "vitest";
import type { PreparedDocument } from "./quick-types";

import {
  CHAT_EVIDENCE_BUDGET,
  composeChatEvidenceAppend,
  composeChatRetrievalFailureNotice,
} from "./chat-evidence";
import { MEMORY_APPEND_BUDGET } from "../memory/inject";

function doc(overrides: Partial<PreparedDocument> = {}): PreparedDocument {
  return {
    url: "https://a.com/p",
    title: "标题 A",
    text: "正文 A",
    truncated: false,
    fetchMethod: "http",
    ...overrides,
  };
}

describe("composeChatEvidenceAppend 预算隔离", () => {
  it("证据预算独立于记忆预算，且明显更大（两者语义不同，不能共用一个数）", () => {
    expect(CHAT_EVIDENCE_BUDGET).toBeGreaterThan(MEMORY_APPEND_BUDGET);
  });

  it("多篇文档不超过预算", () => {
    const docs = Array.from({ length: 10 }, (_v, i) =>
      doc({ url: `https://a.com/${i}`, text: "x".repeat(3000) }),
    );
    expect(composeChatEvidenceAppend(docs).length).toBeLessThanOrEqual(
      CHAT_EVIDENCE_BUDGET + 500, // 头部说明不算在正文预算里
    );
  });

  it("整篇放不下就整篇弃，不做段内截断（残句比少一篇更危险）", () => {
    const small = 400;
    const result = composeChatEvidenceAppend(
      [doc({ url: "https://a.com/1", text: "短文" }), doc({ url: "https://a.com/2", text: "y".repeat(1000) })],
      small,
    );
    expect(result).toContain("https://a.com/1");
    expect(result).not.toContain("https://a.com/2");
  });

  it("第一篇即超预算时硬截并标注（否则开了功能却永远注入空内容）", () => {
    const result = composeChatEvidenceAppend([doc({ text: "y".repeat(5000) })], 500);
    expect(result).toContain("https://a.com/p");
    expect(result).toContain("以上为节选");
  });
});

describe("composeChatEvidenceAppend 内容", () => {
  it("每篇都带 URL——引用锚在 URL 上，不发明查不回去的 chunkId", () => {
    const result = composeChatEvidenceAppend([doc()]);
    expect(result).toContain("来源：https://a.com/p");
    expect(result).not.toMatch(/chunk[_-]?id/i);
  });

  it("标题缺失时用 URL 兜底", () => {
    const result = composeChatEvidenceAppend([doc({ title: undefined })]);
    expect(result).toContain("【https://a.com/p】");
  });

  it("已截断的正文加节选标注", () => {
    const result = composeChatEvidenceAppend([doc({ truncated: true })]);
    expect(result).toContain("以上为节选");
  });

  it("指示模型标注来源，并把未覆盖部分与自己的判断区分开", () => {
    const result = composeChatEvidenceAppend([doc()]);
    expect(result).toContain("标注来源");
    expect(result).toContain("不要把推测写成来自这些来源的事实");
  });

  it("跳过空正文的文档", () => {
    const result = composeChatEvidenceAppend([doc({ text: "   " }), doc({ url: "https://b.com", text: "有料" })]);
    expect(result).not.toContain("https://a.com/p");
    expect(result).toContain("https://b.com");
  });
});

describe("composeChatEvidenceAppend 空结果", () => {
  /// 这条是 spec §15.1「Research 失败不阻断普通会话，但必须说明未完成实时验证」的落点。
  it("一篇都没抓到时返回明确说明，而不是空字符串", () => {
    const result = composeChatEvidenceAppend([]);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("没能验证最新信息");
    expect(result).toContain("可能已过时");
  });

  it("全部文档正文为空时同样走空结果说明", () => {
    expect(composeChatEvidenceAppend([doc({ text: "" })])).toContain("没能验证最新信息");
  });
});

// ── 故障通知与「搜到 0 条」必须分开 ────────────────────────────────────────────
//
// 上线首日的真实事故：前置检索因搜索后端故障失败，却注入了「本轮已尝试联网检索，但没有取到
// 可用资料」。模型的工具调用记录里**没有任何检索**，于是它下一轮只好跟用户解释
// 「之前的声明是系统预设的提示——实际上我还没有主动尝试过联网检索」。
// 让模型对用户讨论系统提示的来源，是文案与事实脱节造成的，必须从源头分开这两种情形。
describe("composeChatRetrievalFailureNotice", () => {
  it("不声称检索已执行（这正是把模型逼去解释系统提示的那句话）", () => {
    const notice = composeChatRetrievalFailureNotice();
    expect(notice).not.toContain("已尝试");
    expect(notice).not.toContain("没有取到可用资料");
  });

  it("要求模型如实告知未联网核对", () => {
    expect(composeChatRetrievalFailureNotice()).toContain("没有联网");
  });

  /// 防编造：故障时模型手里没有任何来源，绝不能顺嘴写出"据某网站"。
  it("明确禁止声称查阅过网络资料", () => {
    expect(composeChatRetrievalFailureNotice()).toContain("不要声称");
  });

  it("带上原因供模型如实转述（用户才有排查线索）", () => {
    expect(composeChatRetrievalFailureNotice("检索超时")).toContain("检索超时");
  });

  /// 原因来自底层异常，可能很长甚至带栈。注入段不该被它挤占，且模型不需要看栈。
  it("超长原因被截断", () => {
    const notice = composeChatRetrievalFailureNotice("x".repeat(2000));
    expect(notice.length).toBeLessThan(500);
  });

  it("与「搜到 0 条」的说明段是两段不同的文本", () => {
    expect(composeChatRetrievalFailureNotice()).not.toBe(composeChatEvidenceAppend([]));
  });
});

/// 0 结果的说明段同样要防编造：检索确实跑了但两手空空，模型也不该编来源。
describe("composeChatEvidenceAppend 零结果说明", () => {
  it("如实说明检索已执行但没取到", () => {
    const notice = composeChatEvidenceAppend([]);
    expect(notice).toContain("没能验证最新信息");
  });

  it("禁止声称查阅过网络资料", () => {
    expect(composeChatEvidenceAppend([])).toContain("不要声称");
  });
});
