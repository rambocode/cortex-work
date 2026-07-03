import { describe, expect, it } from "vitest";
import { ConversationLayoutBuilder } from "./conversation-layout";
import {
  filterOcrBlocksForVisibleConversation,
  shouldPreferOcrForVisibleConversation,
} from "./ocr-conversation-region";
import type { OCRBoundingBox, OCRTextBlock } from "./types";

function ocrBox(x: number, y: number, w: number, h: number): OCRBoundingBox {
  return { x, y, width: w, height: h };
}

function block(text: string, box: OCRBoundingBox): OCRTextBlock {
  return { text, boundingBox: box };
}

const commonMainWindowBlocks = [
  block("搜索", ocrBox(0.08, 0.92, 0.12, 0.03)),
  block("折叠的聊天", ocrBox(0.12, 0.78, 0.16, 0.04)),
  block("传感器异常报警...", ocrBox(0.12, 0.74, 0.18, 0.03)),
  block("冯陈其", ocrBox(0.12, 0.63, 0.12, 0.04)),
  block("我们接这项目的...", ocrBox(0.12, 0.59, 0.18, 0.03)),
  block("张丽莹 hr", ocrBox(0.12, 0.13, 0.14, 0.04)),
  block("这个和张姐说过...", ocrBox(0.12, 0.09, 0.2, 0.03)),
  block("张丽莹 hr", ocrBox(0.32, 0.91, 0.18, 0.04)),
  block("你那有培训的 PPT 吗", ocrBox(0.33, 0.69, 0.18, 0.04)),
  block("你自己做的课件什么的", ocrBox(0.33, 0.58, 0.22, 0.04)),
  block("随便啥都行", ocrBox(0.33, 0.35, 0.12, 0.04)),
  block("这个和张姐说过了，让她问陈琦要一下培训资料吧", ocrBox(0.33, 0.2, 0.34, 0.04)),
];

describe("filterOcrBlocksForVisibleConversation", () => {
  it.each([
    ["微信", { name: "微信", bundleId: "com.tencent.xinWeChat" }],
    ["企业微信", { name: "企业微信", bundleId: "com.tencent.WeWorkMac" }],
    ["钉钉", { name: "钉钉", bundleId: "com.alibaba.DingTalkMac" }],
    ["飞书", { name: "飞书", bundleId: "com.larksuite.Lark" }],
  ])("%s 主窗口不信任 AX 整窗文本，应优先走 OCR 会话区裁剪", (_label, capturedApp) => {
    expect(shouldPreferOcrForVisibleConversation(capturedApp)).toBe(true);
  });

  it.each([
    ["企业微信", { name: "企业微信", bundleId: "com.tencent.WeWorkMac" }],
    ["钉钉", { name: "钉钉", bundleId: "com.alibaba.DingTalkMac" }],
    ["飞书", { name: "飞书", bundleId: "com.larksuite.Lark" }],
  ])("%s 主窗口 OCR 只保留右侧打开的对话区", (_label, capturedApp) => {
    const filtered = filterOcrBlocksForVisibleConversation(commonMainWindowBlocks, capturedApp);
    const text = filtered.map((b) => b.text).join("\n");

    expect(text).not.toContain("折叠的聊天");
    expect(text).not.toContain("冯陈其");
    expect(text).toContain("你那有培训的 PPT 吗");
    expect(text).toContain("这个和张姐说过了");

    const transcript = new ConversationLayoutBuilder().transcript(filtered);
    expect(transcript).not.toContain("传感器异常报警");
    expect(transcript).toContain("对方：你那有培训的 PPT 吗");
    expect(transcript).toContain("这个和张姐说过了");
  });

  it("企业微信主窗口 OCR 会剔除背景水印块", () => {
    const filtered = filterOcrBlocksForVisibleConversation(
      [
        ...commonMainWindowBlocks,
        block("兰江伟 @ 多协信息 7160", ocrBox(0.52, 0.72, 0.24, 0.03)),
        block("兰江伟@多协信息7160", ocrBox(0.66, 0.46, 0.2, 0.03)),
        block("@何晓娟 你可以看一下文档", ocrBox(0.33, 0.28, 0.22, 0.04)),
      ],
      { name: "企业微信", bundleId: "com.tencent.WeWorkMac" },
    );
    const text = filtered.map((b) => b.text).join("\n");

    expect(text).not.toContain("多协信息");
    expect(text).not.toContain("7160");
    expect(text).toContain("@何晓娟 你可以看一下文档");
    expect(text).toContain("你那有培训的 PPT 吗");

    const transcript = new ConversationLayoutBuilder().transcript(filtered);
    expect(transcript).not.toContain("多协信息");
    expect(transcript).not.toContain("7160");
    expect(transcript).toContain("@何晓娟 你可以看一下文档");
  });

  it("企业微信独立会话区 OCR 会剔除顶部资料、签名、水印残片和底部工具栏", () => {
    const filtered = filterOcrBlocksForVisibleConversation(
      [
        block("王子怡", ocrBox(0.03, 0.93, 0.08, 0.04)),
        block("产品经理助理", ocrBox(0.14, 0.93, 0.14, 0.03)),
        block("多做多错 少做少错 不做不错 不错不错", ocrBox(0.03, 0.89, 0.34, 0.03)),
        block("今天", ocrBox(0.48, 0.76, 0.05, 0.03)),
        block("王子怡 7/3 14:19", ocrBox(0.03, 0.68, 0.16, 0.03)),
        block(
          "https://pmis.giterlab.com/#/pm/project/a03e7e37ac78404b9e36607c8aa489d5/task2?",
          ocrBox(0.04, 0.62, 0.78, 0.04),
        ),
        block(
          "id=e5dcca5bd6f446c0a454f7233ef26d82 兰总这个缺陷是，最后已经修约完成的平均值相减",
          ocrBox(0.04, 0.57, 0.82, 0.04),
        ),
        block("CORNERSTONE", ocrBox(0.07, 0.47, 0.18, 0.04)),
        block("pmis.giterlab.com", ocrBox(0.07, 0.42, 0.2, 0.03)),
        block("兰江伟 7/3 14:21", ocrBox(0.03, 0.27, 0.17, 0.03)),
        block("好的，晚上我看下，等下去医院", ocrBox(0.04, 0.21, 0.28, 0.04)),
        block("王子怡 7/3 14:21", ocrBox(0.03, 0.15, 0.16, 0.03)),
        block("兰江伟◎多协信息 7160", ocrBox(0.16, 0.12, 0.24, 0.03)),
        block("好的", ocrBox(0.04, 0.09, 0.06, 0.04)),
        block("多协信息 7160", ocrBox(0.47, 0.06, 0.13, 0.03)),
        block("兰江雨", ocrBox(0.24, 0.08, 0.07, 0.03)),
        block("快速会议", ocrBox(0.86, 0.03, 0.1, 0.03)),
        block("⚡ 快速会议", ocrBox(0.86, 0.11, 0.12, 0.05)),
      ],
      { name: "企业微信", bundleId: "com.tencent.WeWorkMac" },
    );
    const text = filtered.map((b) => b.text).join("\n");

    expect(text).not.toContain("产品经理助理");
    expect(text).not.toContain("多做多错");
    expect(text).not.toContain("兰江伟◎多协信息");
    expect(text).not.toContain("多协信息 7160");
    expect(text).not.toContain("兰江雨");
    expect(text).not.toContain("快速会议");
    expect(text).toContain("兰总这个缺陷是");
    expect(text).toContain("好的，晚上我看下");
    expect(text).toContain("好的");

    const transcript = new ConversationLayoutBuilder().transcript(filtered);
    expect(transcript).not.toContain("产品经理助理");
    expect(transcript).not.toContain("多做多错");
    expect(transcript).not.toContain("多协信息");
    expect(transcript).not.toContain("快速会议");
    expect(transcript).toContain("兰总这个缺陷是");
    expect(transcript).toContain("好的，晚上我看下");
    expect(transcript).toContain("好的");
  });

  it("钉钉独立会话区 OCR 会剔除当前用户名、已读状态和底部工具栏", () => {
    const filtered = filterOcrBlocksForVisibleConversation(
      [
        block("李金剑（AI大模型、GPU、IDC上云、信创数据库、建站）", ocrBox(0.06, 0.94, 0.54, 0.04)),
        block("您方便提交个未支付订单吗", ocrBox(0.08, 0.78, 0.24, 0.04)),
        block("我给您申请优惠", ocrBox(0.08, 0.66, 0.16, 0.04)),
        block("改天吧", ocrBox(0.86, 0.54, 0.07, 0.04)),
        block("江伟", ocrBox(0.95, 0.54, 0.04, 0.04)),
        block("已读", ocrBox(0.9, 0.49, 0.04, 0.03)),
        block("好的，您方便了跟我说", ocrBox(0.08, 0.39, 0.22, 0.04)),
        block("今天 13:41", ocrBox(0.47, 0.31, 0.08, 0.03)),
        block("订单创建了", ocrBox(0.82, 0.2, 0.11, 0.04)),
        block("江伟", ocrBox(0.95, 0.2, 0.04, 0.04)),
        block("已读", ocrBox(0.9, 0.15, 0.04, 0.03)),
        block("好的", ocrBox(0.08, 0.08, 0.05, 0.04)),
        block("［ 看待办", ocrBox(0.02, 0.02, 0.09, 0.03)),
        block("勹看闲忙", ocrBox(0.12, 0.02, 0.1, 0.03)),
        block("试试灵动回复（⌘+D）", ocrBox(0.24, 0.02, 0.2, 0.03)),
        block("凸~Aa", ocrBox(0.04, 0.0, 0.06, 0.03)),
        block("同 发送一～", ocrBox(0.72, 0.0, 0.1, 0.03)),
        block("C 发送/出C 换行", ocrBox(0.84, 0.0, 0.14, 0.03)),
      ],
      { name: "钉钉", bundleId: "com.alibaba.DingTalkMac" },
    );
    const text = filtered.map((b) => b.text).join("\n");

    expect(text).not.toContain("江伟");
    expect(text).not.toContain("已读");
    expect(text).not.toContain("看待办");
    expect(text).not.toContain("看闲忙");
    expect(text).not.toContain("灵动回复");
    expect(text).not.toContain("发送");
    expect(text).not.toContain("换行");
    expect(text).toContain("您方便提交个未支付订单吗");
    expect(text).toContain("改天吧");
    expect(text).toContain("订单创建了");

    const transcript = new ConversationLayoutBuilder().transcript(filtered);
    expect(transcript).not.toContain("江伟");
    expect(transcript).not.toContain("已读");
    expect(transcript).not.toContain("看待办");
    expect(transcript).not.toContain("发送");
    expect(transcript).toContain("对方：您方便提交个未支付订单吗");
    expect(transcript).toContain("我：改天吧");
    expect(transcript).toContain("我：订单创建了");
  });

  it("非 IM 应用不做裁剪", () => {
    expect(
      shouldPreferOcrForVisibleConversation({
        name: "Google Chrome",
        bundleId: "com.google.Chrome",
      }),
    ).toBe(false);

    const filtered = filterOcrBlocksForVisibleConversation(commonMainWindowBlocks, {
      name: "Google Chrome",
      bundleId: "com.google.Chrome",
    });

    expect(filtered).toBe(commonMainWindowBlocks);
  });
});
