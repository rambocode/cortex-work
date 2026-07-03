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

// 用户实测错乱案例回归（微信 902x727 主窗，2026-07-04 截图标定）：
// 列表长文本横跨 0.24~0.34 一带 → 分栏线曾被错选在列表内部的时间/徽章列（~0.29），
// 列表右缘「星期四」「0天备考..」残留进对话区；顶部第一条消息（midY≈0.92）曾被 0.86 阈值误杀。
const wechatMisparseBlocks = [
  // 左侧会话列表（主文字列 + 右缘时间列）
  block("搜索", ocrBox(0.08, 0.955, 0.1, 0.025)),
  block("老婆", ocrBox(0.13, 0.86, 0.06, 0.03)),
  block("具体什么报错。", ocrBox(0.13, 0.8, 0.16, 0.028)),
  block("文件传输助手", ocrBox(0.13, 0.72, 0.14, 0.03)),
  block("201室的小伙伴们", ocrBox(0.13, 0.62, 0.15, 0.03)),
  block("养猪经验交流", ocrBox(0.13, 0.5, 0.13, 0.03)),
  block("公众号", ocrBox(0.13, 0.3, 0.08, 0.03)),
  block("西溪之星 36-47 幢", ocrBox(0.13, 0.2, 0.16, 0.03)),
  block("昨天 23:01", ocrBox(0.3, 0.86, 0.07, 0.025)),
  block("星期四", ocrBox(0.31, 0.72, 0.05, 0.025)),
  block("星期四", ocrBox(0.31, 0.62, 0.05, 0.025)),
  block("昨天 23:26", ocrBox(0.3, 0.2, 0.07, 0.025)),
  // 横跨 0.24~0.31 候选线的列表长文本 + 徽章残片
  block("浙商大 胡晓慧老师: 考前3", ocrBox(0.13, 0.12, 0.21, 0.028)),
  block("0天备考..", ocrBox(0.24, 0.115, 0.1, 0.028)),
  // 右侧对话区（顶部第一条是我方消息，midY≈0.92）
  block("爷爷去吧,我明天下午约的去开中药", ocrBox(0.65, 0.905, 0.28, 0.035)),
  block("星期四 18:57", ocrBox(0.53, 0.85, 0.13, 0.025)),
  block("升级了，你更新一下试试，看看那个新功能", ocrBox(0.56, 0.76, 0.36, 0.035)),
  block("星期四 19:12", ocrBox(0.53, 0.68, 0.13, 0.025)),
  block("这么快", ocrBox(0.45, 0.6, 0.07, 0.03)),
  block("星期四 19:54", ocrBox(0.53, 0.52, 0.13, 0.025)),
  block("没看到有提示更新啊", ocrBox(0.45, 0.44, 0.16, 0.03)),
  block("星期四 19:56", ocrBox(0.53, 0.36, 0.13, 0.025)),
  block("暑期课的上课时间是:", ocrBox(0.46, 0.28, 0.17, 0.03)),
  block("周二、周五，下午1-2点。", ocrBox(0.46, 0.24, 0.2, 0.03)),
  block("7月3号-8月14号，一周2次课。", ocrBox(0.46, 0.17, 0.24, 0.03)),
  block("总共上13次课，一节课60分钟，100元一节。", ocrBox(0.46, 0.1, 0.34, 0.03)),
];

describe("微信 OCR 重建错乱回归（用户实测案例）", () => {
  it("列表残留/时间戳全剔除，说话人归属正确，顶部第一条消息不丢", () => {
    const filtered = filterOcrBlocksForVisibleConversation(
      wechatMisparseBlocks,
      { name: "微信", bundleId: "com.tencent.xinWeChat" },
      { windowHeightPt: 727 },
    );
    const transcript = new ConversationLayoutBuilder().transcript(filtered);

    // 左列表内容（含右缘时间列与徽章残片）不得进入重建
    expect(transcript).not.toContain("星期四");
    expect(transcript).not.toContain("昨天");
    expect(transcript).not.toContain("备考");
    expect(transcript).not.toContain("文件传输助手");
    // 对话区时间戳整块剔除
    expect(transcript).not.toContain("18:57");
    expect(transcript).not.toContain("19:12");
    // 顶部第一条我方消息保留且归属正确
    expect(transcript).toContain("我：爷爷去吧,我明天下午约的去开中药");
    expect(transcript).toContain("我：升级了，你更新一下试试，看看那个新功能");
    // 对方消息不被误标为「我」、不被误判居中
    expect(transcript).toContain("对方：这么快");
    expect(transcript).toContain("对方：没看到有提示更新啊");
    expect(transcript).toContain("对方：暑期课的上课时间是:");
  });
});

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

  it("钉钉主窗口 OCR 会剔除左侧会话列表，只保留打开的对话", () => {
    const filtered = filterOcrBlocksForVisibleConversation(
      [
        block("2021级1班（家校", ocrBox(0.07, 0.82, 0.18, 0.03)),
        block("巨匠：恭喜大家毕业啦！", ocrBox(0.07, 0.78, 0.24, 0.03)),
        block("AI 助理", ocrBox(0.07, 0.7, 0.08, 0.03)),
        block("聊聊新话题", ocrBox(0.07, 0.66, 0.1, 0.03)),
        block("钉钉安全助手", ocrBox(0.07, 0.58, 0.13, 0.03)),
        block("账号安全提醒", ocrBox(0.07, 0.54, 0.12, 0.03)),
        block("洪园社区", ocrBox(0.07, 0.46, 0.09, 0.03)),
        block("王晨轩 王梓萱妈妈今日在钉钉…", ocrBox(0.07, 0.42, 0.28, 0.03)),
        block("多协信⋯.", ocrBox(0.07, 0.34, 0.09, 0.03)),
        block("云服务通知：【云监控】云服务器⋯.", ocrBox(0.07, 0.3, 0.3, 0.03)),
        block("giterlab...", ocrBox(0.07, 0.2, 0.1, 0.03)),
        block("培训）17:39", ocrBox(0.07, 0.16, 0.11, 0.03)),
        block("您方便提交个未支付订单吗", ocrBox(0.52, 0.78, 0.24, 0.04)),
        block("我给您申请优惠", ocrBox(0.52, 0.66, 0.16, 0.04)),
        block("改天吧", ocrBox(0.86, 0.54, 0.07, 0.04)),
        block("江伟", ocrBox(0.95, 0.54, 0.04, 0.04)),
        block("已读", ocrBox(0.9, 0.49, 0.04, 0.03)),
        block("好的，您方便了跟我说", ocrBox(0.52, 0.39, 0.22, 0.04)),
        block("今天 13:41", ocrBox(0.68, 0.31, 0.08, 0.03)),
        block("订单创建了", ocrBox(0.82, 0.2, 0.11, 0.04)),
        block("江伟", ocrBox(0.95, 0.2, 0.04, 0.04)),
        block("已读", ocrBox(0.9, 0.15, 0.04, 0.03)),
        block("好的", ocrBox(0.52, 0.08, 0.05, 0.04)),
        block("［ 看待办", ocrBox(0.44, 0.02, 0.09, 0.03)),
        block("囟看闲忙", ocrBox(0.54, 0.02, 0.1, 0.03)),
        block("试试灵动回复（⌘+D）", ocrBox(0.66, 0.02, 0.2, 0.03)),
      ],
      { name: "钉钉", bundleId: "com.alibaba.DingTalkMac" },
    );
    const text = filtered.map((b) => b.text).join("\n");

    expect(text).not.toContain("2021级1班");
    expect(text).not.toContain("钉钉安全助手");
    expect(text).not.toContain("洪园社区");
    expect(text).not.toContain("giterlab");
    expect(text).not.toContain("江伟");
    expect(text).not.toContain("已读");
    expect(text).not.toContain("看待办");
    expect(text).not.toContain("灵动回复");
    expect(text).toContain("您方便提交个未支付订单吗");
    expect(text).toContain("我给您申请优惠");
    expect(text).toContain("改天吧");
    expect(text).toContain("订单创建了");

    const transcript = new ConversationLayoutBuilder().transcript(filtered);
    expect(transcript).not.toContain("2021级1班");
    expect(transcript).not.toContain("钉钉安全助手");
    expect(transcript).toContain("对方：您方便提交个未支付订单吗");
    expect(transcript).toContain("对方：我给您申请优惠");
    expect(transcript).toContain("我：改天吧");
    expect(transcript).toContain("我：订单创建了");
  });

  it("输入框锚点存在时优先按锚点左移 50px 裁剪当前对话区", () => {
    const filtered = filterOcrBlocksForVisibleConversation(
      [
        block("钉钉安全助手", ocrBox(0.07, 0.7, 0.13, 0.03)),
        block("账号安全提醒", ocrBox(0.07, 0.66, 0.12, 0.03)),
        block("洪园社区", ocrBox(0.07, 0.46, 0.09, 0.03)),
        block("giterlab...", ocrBox(0.07, 0.2, 0.1, 0.03)),
        block("您方便提交个未支付订单吗", ocrBox(0.52, 0.78, 0.24, 0.04)),
        block("我给您申请优惠", ocrBox(0.52, 0.66, 0.16, 0.04)),
        block("改天吧", ocrBox(0.86, 0.54, 0.07, 0.04)),
        block("订单创建了", ocrBox(0.82, 0.2, 0.11, 0.04)),
      ],
      { name: "钉钉", bundleId: "com.alibaba.DingTalkMac" },
      { inputAnchor: { x: 0.55, y: 0.92, leftPadding: 0.05 } },
    );
    const text = filtered.map((b) => b.text).join("\n");

    expect(text).not.toContain("钉钉安全助手");
    expect(text).not.toContain("洪园社区");
    expect(text).not.toContain("giterlab");
    expect(text).toContain("您方便提交个未支付订单吗");
    expect(text).toContain("订单创建了");
  });

  it("钉钉输入框上方工具栏较高时仍会剔除", () => {
    const filtered = filterOcrBlocksForVisibleConversation(
      [
        block("您方便提交个未支付订单吗", ocrBox(0.52, 0.78, 0.24, 0.04)),
        block("我给您申请优惠", ocrBox(0.52, 0.66, 0.16, 0.04)),
        block("改天吧", ocrBox(0.86, 0.54, 0.07, 0.04)),
        block("订单创建了", ocrBox(0.82, 0.28, 0.11, 0.04)),
        block("好的", ocrBox(0.52, 0.22, 0.05, 0.04)),
        block("［ 看待办", ocrBox(0.44, 0.2, 0.09, 0.04)),
        block("勹看闲忙", ocrBox(0.54, 0.19, 0.1, 0.04)),
        block("试试灵动回复（⌘+D）", ocrBox(0.66, 0.18, 0.2, 0.04)),
        block("试试灵动回复（86+D）", ocrBox(0.03, 0.07, 0.18, 0.04)),
      ],
      { name: "钉钉", bundleId: "com.alibaba.DingTalkMac" },
      { inputAnchor: { x: 0.52, y: 0.88, leftPadding: 0.05 } },
    );
    const text = filtered.map((b) => b.text).join("\n");

    expect(text).not.toContain("看待办");
    expect(text).not.toContain("看闲忙");
    expect(text).not.toContain("灵动回复");
    expect(text).toContain("您方便提交个未支付订单吗");
    expect(text).toContain("订单创建了");
    expect(text).toContain("好的");
  });

  it("钉钉底部辅助按钮没有左侧头像语境时不会当成对方消息", () => {
    const filtered = filterOcrBlocksForVisibleConversation(
      [
        block("您方便提交个未支付订单吗", ocrBox(0.08, 0.78, 0.24, 0.04)),
        block("我给您申请优惠", ocrBox(0.08, 0.66, 0.16, 0.04)),
        block("改天吧", ocrBox(0.86, 0.54, 0.07, 0.04)),
        block("订单创建了", ocrBox(0.82, 0.35, 0.11, 0.04)),
        block("好的", ocrBox(0.08, 0.28, 0.05, 0.04)),
        block("［ 看待办", ocrBox(0.03, 0.3, 0.09, 0.04)),
        block("囟看闲忙", ocrBox(0.14, 0.3, 0.1, 0.04)),
      ],
      { name: "钉钉", bundleId: "com.alibaba.DingTalkMac" },
      { inputAnchor: { x: 0.08, y: 0.88, leftPadding: 0.05 } },
    );

    const transcript = new ConversationLayoutBuilder().transcript(filtered);

    expect(transcript).not.toContain("看待办");
    expect(transcript).not.toContain("看闲忙");
    expect(transcript).toContain("对方：您方便提交个未支付订单吗");
    expect(transcript).toContain("我：订单创建了");
    expect(transcript).toContain("对方：好的");
  });

  it("钉钉底部真实消息包含辅助按钮词时仍会保留", () => {
    const filtered = filterOcrBlocksForVisibleConversation(
      [
        block("您方便提交个未支付订单吗", ocrBox(0.08, 0.78, 0.24, 0.04)),
        block("订单创建了", ocrBox(0.82, 0.54, 0.11, 0.04)),
        block("看待办了吗", ocrBox(0.08, 0.3, 0.12, 0.04)),
      ],
      { name: "钉钉", bundleId: "com.alibaba.DingTalkMac" },
      { inputAnchor: { x: 0.08, y: 0.88, leftPadding: 0.05 } },
    );

    const transcript = new ConversationLayoutBuilder().transcript(filtered);

    expect(transcript).toContain("对方：看待办了吗");
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
