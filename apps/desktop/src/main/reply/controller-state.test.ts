import { describe, it, expect } from "vitest";
import {
  ReplySession,
  looksLikeConversation,
  shouldAbortWriteBack,
  cleanAgentOutput,
} from "./controller-state";

describe("ReplySession 状态机转移", () => {
  it("idle→capturing→generating→presenting 主链路", () => {
    const s = new ReplySession();
    expect(s.phase).toBe("idle");
    const token = s.beginCapture();
    expect(s.phase).toBe("capturing");
    expect(token).toBe(1);
    s.toGenerating();
    expect(s.phase).toBe("generating");
    s.presentFirst("你好");
    expect(s.phase).toBe("presenting");
    expect(s.candidates).toEqual(["你好"]);
    expect(s.currentIndex).toBe(0);
    expect(s.currentDraft).toBe("你好");
  });

  it("voice：idle→recording，voice-end 经 beginCapture→capturing", () => {
    const s = new ReplySession();
    s.beginRecording();
    expect(s.phase).toBe("recording");
    s.beginCapture();
    expect(s.phase).toBe("capturing");
  });

  it("beginRecording 递增 token 并清空上一轮候选（每次按住语音键都是新会话）", () => {
    const s = new ReplySession();
    s.beginCapture();
    s.presentFirst("旧候选");
    s.setCapturedPid(42);
    const t = s.beginRecording();
    expect(t).toBe(2); // beginCapture(1) → beginRecording(2)
    expect(s.phase).toBe("recording");
    expect(s.candidates).toEqual([]);
    expect(s.currentIndex).toBe(0);
    expect(s.capturedPid).toBeNull();
  });

  it("连续两次 beginRecording：旧 token 失效（作废上一轮遗留提示定时器）", () => {
    const s = new ReplySession();
    const t1 = s.beginRecording();
    const t2 = s.beginRecording();
    expect(t2).toBe(t1 + 1);
    expect(s.isCurrent(t1)).toBe(false); // 上一轮语音会话的过期回调/定时器被丢弃
    expect(s.isCurrent(t2)).toBe(true);
  });

  it("recording→idle：空识别 / 失败经 reset 回 idle 并作废在途 token", () => {
    const s = new ReplySession();
    const t = s.beginRecording();
    expect(s.phase).toBe("recording");
    s.reset(); // 提示后回 idle
    expect(s.phase).toBe("idle");
    expect(s.isCurrent(t)).toBe(false);
  });

  it("beginCapture 递增 token 并清空上一轮候选", () => {
    const s = new ReplySession();
    s.beginCapture();
    s.presentFirst("a");
    s.appendFlip("b");
    expect(s.candidates).toEqual(["a", "b"]);
    const t2 = s.beginCapture();
    expect(t2).toBe(2);
    expect(s.candidates).toEqual([]);
    expect(s.currentIndex).toBe(0);
    expect(s.capturedPid).toBeNull();
  });

  it("过期 token 回调按 isCurrent 丢弃（新捕获后旧 token 失效）", () => {
    const s = new ReplySession();
    const t1 = s.beginCapture();
    expect(s.isCurrent(t1)).toBe(true);
    const t2 = s.beginCapture(); // 重入/新一轮
    expect(s.isCurrent(t1)).toBe(false); // 旧回调过期
    expect(s.isCurrent(t2)).toBe(true);
  });

  it("重入取消：generating/presenting 中 beginCapture 递增 token 且回 capturing", () => {
    const s = new ReplySession();
    const t1 = s.beginCapture();
    s.toGenerating();
    const t2 = s.beginCapture(); // 生成中重入
    expect(t2).toBe(t1 + 1);
    expect(s.phase).toBe("capturing");
    expect(s.isCurrent(t1)).toBe(false);

    s.toGenerating();
    s.presentFirst("x");
    const t3 = s.beginCapture(); // 展示中重入
    expect(t3).toBe(t2 + 1);
    expect(s.phase).toBe("capturing");
  });

  it("esc / reset：回 idle 并递增 token 作废在途回调", () => {
    const s = new ReplySession();
    const t1 = s.beginCapture();
    s.toGenerating();
    s.reset();
    expect(s.phase).toBe("idle");
    expect(s.isCurrent(t1)).toBe(false); // 在途 CLI 回调将被丢弃
    expect(s.candidates).toEqual([]);
  });

  it("写回：presenting→writing→reset(idle)", () => {
    const s = new ReplySession();
    s.beginCapture();
    s.presentFirst("draft");
    s.setCapturedPid(123);
    s.toWriting();
    expect(s.phase).toBe("writing");
    expect(s.capturedPid).toBe(123);
    s.reset();
    expect(s.phase).toBe("idle");
    expect(s.capturedPid).toBeNull();
  });

  it("写回世代守卫：writing 期间 beginCapture 递增 token 使写回旧 token 失效（不作废新会话）", () => {
    const s = new ReplySession();
    s.beginCapture();
    s.presentFirst("draft");
    const writeToken = s.token; // writeBack 进入时捕获的 token
    s.toWriting();
    // 写回 await 期间新 draft-gesture 起新会话
    const newToken = s.beginCapture();
    expect(newToken).toBe(writeToken + 1);
    // 旧写回回来时 isCurrent 应为 false → controller 据此放弃 reset/清 pending
    expect(s.isCurrent(writeToken)).toBe(false);
    expect(s.isCurrent(newToken)).toBe(true);
  });

  it("beginRegenerate：递增 token、回 generating、清空候选，但保留 capturedPid（错误态重试复用捕获）", () => {
    const s = new ReplySession();
    const t1 = s.beginCapture();
    s.setCapturedPid(77);
    s.presentFirst("旧候选");
    s.appendFlip("旧候选2");
    const t2 = s.beginRegenerate();
    expect(t2).toBe(t1 + 1);
    expect(s.phase).toBe("generating");
    expect(s.candidates).toEqual([]);
    expect(s.currentIndex).toBe(0);
    // 与 beginCapture 的关键区别：capturedPid 保留（写回目标 pid 不变）
    expect(s.capturedPid).toBe(77);
    // 旧一轮生成回调过期被丢弃（重试单飞裁决点）
    expect(s.isCurrent(t1)).toBe(false);
    expect(s.isCurrent(t2)).toBe(true);
  });

  it("连点重试：连续 beginRegenerate 使前一轮 token 失效（单飞，只留最后一个生成）", () => {
    const s = new ReplySession();
    s.beginCapture();
    s.setCapturedPid(5);
    const r1 = s.beginRegenerate();
    const r2 = s.beginRegenerate();
    expect(r2).toBe(r1 + 1);
    expect(s.isCurrent(r1)).toBe(false); // 上一轮重试的在途 CLI 回调被丢弃
    expect(s.isCurrent(r2)).toBe(true);
    expect(s.capturedPid).toBe(5); // 全程保留写回目标
  });
});

describe("ReplySession 候选管理", () => {
  it("首条到达即 presenting，索引为 0", () => {
    const s = new ReplySession();
    s.beginCapture();
    s.toGenerating();
    s.presentFirst("first");
    expect(s.phase).toBe("presenting");
    expect(s.currentIndex).toBe(0);
  });

  it("预生成候选追加不打断当前索引，且去重", () => {
    const s = new ReplySession();
    s.beginCapture();
    s.presentFirst("first");
    expect(s.appendPreGenerated("second")).toBe(true);
    expect(s.appendPreGenerated("second")).toBe(false); // 重复忽略
    expect(s.candidates).toEqual(["first", "second"]);
    expect(s.currentIndex).toBe(0); // 用户正看的候选不被移动
  });

  it("非 presenting 阶段拒绝预生成追加", () => {
    const s = new ReplySession();
    s.beginCapture();
    s.toGenerating();
    expect(s.appendPreGenerated("x")).toBe(false);
    expect(s.candidates).toEqual([]);
  });

  it("翻牌追加聚焦到新候选", () => {
    const s = new ReplySession();
    s.beginCapture();
    s.presentFirst("a");
    s.appendFlip("b");
    expect(s.candidates).toEqual(["a", "b"]);
    expect(s.currentIndex).toBe(1);
    expect(s.currentDraft).toBe("b");
  });

  it("翻牌避重列表含当前全部候选", () => {
    const s = new ReplySession();
    s.beginCapture();
    s.presentFirst("a");
    s.appendPreGenerated("b");
    expect(s.avoidList()).toEqual(["a", "b"]);
  });

  it("←/→ 循环切换（环绕）", () => {
    const s = new ReplySession();
    s.beginCapture();
    s.presentFirst("a");
    s.appendPreGenerated("b");
    s.appendPreGenerated("c");
    // 预生成不移动索引，仍在 a
    expect(s.currentIndex).toBe(0);
    s.cycle(-1); // 向左环绕到末尾
    expect(s.currentIndex).toBe(2);
    s.cycle(1); // 环绕回 0
    expect(s.currentIndex).toBe(0);
    s.cycle(1);
    expect(s.currentDraft).toBe("b");
  });
});

describe("looksLikeConversation 启发式", () => {
  it("过短 / 占位符 / 无对话特征 → false", () => {
    expect(looksLikeConversation("太短")).toBe(false);
    expect(looksLikeConversation("输入文字，或按住Fn使用语音输入")).toBe(false);
    expect(looksLikeConversation("abcdefghijklmno")).toBe(false); // 够长但无换行/冒号且 <30
  });

  it("含换行 / 冒号 / 足够长 → true", () => {
    expect(looksLikeConversation("对方：明天有空吗\n我：可以")).toBe(true);
    expect(looksLikeConversation("对方：明天下午我们约个时间见面吗")).toBe(true);
    expect(looksLikeConversation("a".repeat(30))).toBe(true);
  });
});

describe("shouldAbortWriteBack pid 校验", () => {
  it("捕获 pid 缺失 → 中止（不盲粘）", () => {
    expect(shouldAbortWriteBack(null, 123)).toBe(true);
    expect(shouldAbortWriteBack(null, null)).toBe(true);
  });
  it("pid 一致 → 放行；不一致 → 中止", () => {
    expect(shouldAbortWriteBack(123, 123)).toBe(false);
    expect(shouldAbortWriteBack(123, 456)).toBe(true);
    expect(shouldAbortWriteBack(123, null)).toBe(true);
  });
});

describe("cleanAgentOutput 输出清洗", () => {
  it("剥离 markdown 代码围栏", () => {
    expect(cleanAgentOutput("```\n明天上午可以\n```")).toBe("明天上午可以");
    expect(cleanAgentOutput("```text\n收到，稍后回复你\n```")).toBe("收到，稍后回复你");
  });

  it("剥离开场白前缀行", () => {
    expect(cleanAgentOutput("好的，这是回复：\n明天上午我有空")).toBe("明天上午我有空");
    expect(cleanAgentOutput("Here's a reply:\nSounds good to me")).toBe("Sounds good to me");
  });

  it("剥离特殊 token 残渣与角色前缀", () => {
    expect(cleanAgentOutput("正文内容<|im_end|>")).toBe("正文内容");
    expect(cleanAgentOutput("assistant\n我马上处理")).toBe("我马上处理");
  });

  it("脱去成对包裹引号，但保留正文内部引号", () => {
    expect(cleanAgentOutput('"明天见"')).toBe("明天见");
    expect(cleanAgentOutput("「收到」")).toBe("收到");
    // 内部含引号时不脱壳，避免越扒越短
    expect(cleanAgentOutput('他说"好"然后走了')).toBe('他说"好"然后走了');
  });

  it("组合场景：围栏 + 开场白 + 引号", () => {
    expect(cleanAgentOutput('```\n好的，这是回复：\n"明天上午可以"\n```')).toBe("明天上午可以");
  });

  it("纯正文原样返回", () => {
    expect(cleanAgentOutput("明天上午我有空，约 10 点？")).toBe("明天上午我有空，约 10 点？");
  });
});
