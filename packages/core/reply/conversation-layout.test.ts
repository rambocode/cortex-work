// 对话重建行为契约测试。断言逐条移植自 ReplyClone ReplyCoreTests.swift，输入输出保持一致。

import { describe, expect, it } from "vitest";
import { ConversationLayoutBuilder } from "./conversation-layout";
import type { OCRBoundingBox, OCRTextBlock } from "./types";

// Vision 归一化坐标系（原点左下）的测试辅助
function ocrBox(x: number, y: number, w: number, h: number): OCRBoundingBox {
  return { x, y, width: w, height: h };
}
function block(text: string, box: OCRBoundingBox): OCRTextBlock {
  return { text, boundingBox: box };
}

describe("ConversationLayoutBuilder", () => {
  it("左右气泡按 x 对齐区分说话人，按 y 排序，同侧相邻合并", () => {
    const blocks = [
      block("今晚方便开个短会吗？", ocrBox(0.05, 0.8, 0.3, 0.04)),
      block("我这边今晚有安排", ocrBox(0.6, 0.7, 0.35, 0.04)),
      block("明早十点可以吗", ocrBox(0.62, 0.64, 0.33, 0.04)),
      block("可以，明早见", ocrBox(0.05, 0.5, 0.25, 0.04)),
    ];
    const transcript = new ConversationLayoutBuilder().transcript(blocks);
    expect(transcript).toBe(
      "对方：今晚方便开个短会吗？\n我：我这边今晚有安排 明早十点可以吗\n对方：可以，明早见",
    );
  });

  it("微信主窗口左侧聊天列表列整体剔除", () => {
    const blocks = [
      block("张三", ocrBox(0.06, 0.9, 0.1, 0.03)),
      block("李四: 在吗", ocrBox(0.06, 0.8, 0.2, 0.03)),
      block("文件发我一下", ocrBox(0.36, 0.7, 0.25, 0.04)),
      block("好的，马上", ocrBox(0.7, 0.6, 0.25, 0.04)),
    ];
    const transcript = new ConversationLayoutBuilder().transcript(blocks);
    expect(transcript).not.toContain("张三");
    expect(transcript).not.toContain("李四");
    expect(transcript).toBe("对方：文件发我一下\n我：好的，马上");
  });

  it("右侧长消息续行随整个气泡归到「我」", () => {
    const blocks = [
      block("下午有人上门取件", ocrBox(0.33, 0.8, 0.27, 0.04)),
      block("来了的话你帮我把鼠标给人家，我拿去修一下", ocrBox(0.5, 0.7, 0.47, 0.04)),
      block("充电线在插头那里", ocrBox(0.5, 0.655, 0.12, 0.04)),
    ];
    const transcript = new ConversationLayoutBuilder().transcript(blocks);
    expect(transcript).toBe(
      "对方：下午有人上门取件\n我：来了的话你帮我把鼠标给人家，我拿去修一下 充电线在插头那里",
    );
  });

  it("纯符号 / 数字块剔除（语音时长、表情）", () => {
    const blocks = [
      block('● 4"', ocrBox(0.05, 0.8, 0.1, 0.04)),
      block("☺", ocrBox(0.9, 0.7, 0.05, 0.04)),
      block("在家吗", ocrBox(0.05, 0.6, 0.2, 0.04)),
      block("在的", ocrBox(0.8, 0.5, 0.15, 0.04)),
    ];
    const transcript = new ConversationLayoutBuilder().transcript(blocks);
    expect(transcript).toBe("对方：在家吗\n我：在的");
  });

  it("居中时间戳转 [分隔行] 并清尾部残渣", () => {
    const blocks = [
      block("文档周五前发你", ocrBox(0.05, 0.8, 0.3, 0.04)),
      block("6月3日 22:17|", ocrBox(0.35, 0.7, 0.3, 0.03)),
      block("收到，辛苦", ocrBox(0.65, 0.6, 0.3, 0.04)),
    ];
    const transcript = new ConversationLayoutBuilder().transcript(blocks);
    expect(transcript).toBe("对方：文档周五前发你\n[6月3日 22:17]\n我：收到，辛苦");
  });

  it("面板偏斜时时间戳容差 0.25 仍识别为分隔行", () => {
    const blocks = [
      block("在我朋友家里住，我妈刚才给我打电话了", ocrBox(0.1, 0.8, 0.55, 0.04)),
      block("星期日 11:45|", ocrBox(0.44, 0.7, 0.18, 0.03)),
      block("嗯", ocrBox(0.84, 0.6, 0.06, 0.04)),
    ];
    const transcript = new ConversationLayoutBuilder().transcript(blocks);
    expect(transcript).toBe("对方：在我朋友家里住，我妈刚才给我打电话了\n[星期日 11:45]\n我：嗯");
  });

  it("系统事件气泡（已取消 + 残字）按前缀整块剔除", () => {
    const blocks = [
      block("在家吗", ocrBox(0.05, 0.8, 0.2, 0.04)),
      block("已取消的", ocrBox(0.75, 0.7, 0.2, 0.04)),
      block("已取消a", ocrBox(0.75, 0.6, 0.2, 0.04)),
      block("在的", ocrBox(0.8, 0.5, 0.15, 0.04)),
    ];
    const transcript = new ConversationLayoutBuilder({
      systemEventPrefixes: ["已取消"],
    }).transcript(blocks);
    expect(transcript).not.toContain("已取消");
    expect(transcript).toBe("对方：在家吗\n我：在的");
  });

  it("窗口顶部标题栏（midY≥0.95）剔除", () => {
    const blocks = [
      block("思义", ocrBox(0.02, 0.97, 0.06, 0.02)),
      block("下午在吗", ocrBox(0.05, 0.7, 0.25, 0.04)),
      block("在的，什么事", ocrBox(0.7, 0.6, 0.25, 0.04)),
    ];
    const transcript = new ConversationLayoutBuilder().transcript(blocks);
    expect(transcript).not.toContain("思义");
    expect(transcript).toBe("对方：下午在吗\n我：在的，什么事");
  });

  it("噪声标记（输入框占位符）在重建前过滤", () => {
    const blocks = [
      block("周会改到几点？", ocrBox(0.05, 0.8, 0.3, 0.04)),
      block("输入文字，或按住Fn使用语音输入", ocrBox(0.05, 0.1, 0.5, 0.03)),
      block("三点，会议室不变", ocrBox(0.6, 0.6, 0.35, 0.04)),
    ];
    const transcript = new ConversationLayoutBuilder({
      noiseMarkers: ["输入文字"],
    }).transcript(blocks);
    expect(transcript).not.toContain("输入文字");
    expect(transcript).toBe("对方：周会改到几点？\n我：三点，会议室不变");
  });

  it("无可辨认结构时返回空串", () => {
    expect(new ConversationLayoutBuilder().transcript([])).toBe("");
  });
});
