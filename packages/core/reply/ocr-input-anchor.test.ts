import { describe, expect, it } from "vitest";
import { ocrInputBarAnchor } from "./ocr-input-anchor";
import type { OCRBoundingBox, OCRTextBlock } from "./types";

function ocrBox(x: number, y: number, w: number, h: number): OCRBoundingBox {
  return { x, y, width: w, height: h };
}

function block(text: string, box: OCRBoundingBox): OCRTextBlock {
  return { text, boundingBox: box };
}

// 实拍微信主窗布局（wechat-01 取证）：窗口 (717,39) 902x727，
// 输入框 placeholder 位于右侧 pane 底部（Vision 左下原点 → y 很小）。
const WIN = { x: 717, y: 39, width: 902, height: 727 };

// 典型微信 OCR 块：左侧会话列表 + 右侧对话区 + 底部 placeholder
const wechatBlocks: OCRTextBlock[] = [
  block("搜索", ocrBox(0.08, 0.93, 0.1, 0.03)),
  block("老婆", ocrBox(0.13, 0.82, 0.06, 0.03)),
  block("具体什么报错。", ocrBox(0.13, 0.78, 0.16, 0.03)),
  block("文件传输助手", ocrBox(0.13, 0.68, 0.14, 0.03)),
  block("201室的小伙伴们", ocrBox(0.13, 0.55, 0.15, 0.03)),
  block("养猪经验交流", ocrBox(0.13, 0.42, 0.13, 0.03)),
  block("公众号", ocrBox(0.13, 0.18, 0.08, 0.03)),
  block("西溪之星 36-47 幢", ocrBox(0.13, 0.08, 0.16, 0.03)),
  block("老婆", ocrBox(0.4, 0.94, 0.05, 0.03)),
  block("爷爷去吧,我明天下午约的去开中药", ocrBox(0.62, 0.85, 0.3, 0.035)),
  block("升级了，你更新一下试试，看看那个新功能", ocrBox(0.56, 0.72, 0.36, 0.035)),
  block("这么快", ocrBox(0.45, 0.6, 0.07, 0.03)),
  block("没看到有提示更新啊", ocrBox(0.45, 0.47, 0.16, 0.03)),
  block("暑期课的上课时间是:", ocrBox(0.46, 0.32, 0.17, 0.03)),
  block("周二、周五，下午1-2点。", ocrBox(0.46, 0.27, 0.2, 0.03)),
];

const PLACEHOLDER = block(
  "输入文字，或按住Fn使用语音输入",
  ocrBox(0.395, 0.12, 0.26, 0.028),
);

describe("ocrInputBarAnchor", () => {
  it("L1：识别微信输入框 placeholder 行，换算为屏幕坐标锚（左上原点）", () => {
    const anchor = ocrInputBarAnchor([...wechatBlocks, PLACEHOLDER], WIN);
    expect(anchor).not.toBeNull();
    // x = win.x + 0.395 * 902
    expect(anchor!.x).toBeCloseTo(717 + 0.395 * 902, 0);
    // Vision 左下原点 → 屏幕 top-left：top = win.y + (1 - y - height) * win.height
    expect(anchor!.y).toBeCloseTo(39 + (1 - 0.12 - 0.028) * 727, 0);
    expect(anchor!.height).toBeCloseTo(0.028 * 727, 0);
    expect(anchor!.width).toBeCloseTo(0.26 * 902, 0);
  });

  it("L1：placeholder 被 OCR 拆行时任一片段可命中（「按住Fn使用语音输入」）", () => {
    const fragment = block("或按住Fn使用语音输入", ocrBox(0.46, 0.11, 0.18, 0.028));
    const anchor = ocrInputBarAnchor([...wechatBlocks, fragment], WIN);
    expect(anchor).not.toBeNull();
    expect(anchor!.x).toBeCloseTo(717 + 0.46 * 902, 0);
  });

  it("L1：英文界面 Type a message 亦可命中", () => {
    const en = block("Type a message", ocrBox(0.42, 0.1, 0.2, 0.028));
    const anchor = ocrInputBarAnchor([...wechatBlocks, en], WIN);
    expect(anchor).not.toBeNull();
    expect(anchor!.y).toBeCloseTo(39 + (1 - 0.1 - 0.028) * 727, 0);
  });

  it("L1：位于窗口上半部的同文案（消息内容里聊到 placeholder）不误判", () => {
    const chatterAboutPlaceholder = block(
      "输入文字，或按住Fn使用语音输入",
      ocrBox(0.46, 0.62, 0.3, 0.03),
    );
    const anchor = ocrInputBarAnchor([...wechatBlocks, chatterAboutPlaceholder], WIN);
    // 无底部 placeholder → 不能拿上半部的文案当输入框；退 L2（本布局可分栏）
    expect(anchor).not.toBeNull();
    expect(anchor!.y).toBeGreaterThan(39 + 727 / 2);
    // L2 的 x 应贴对话区左缘（splitX ∈ [0.24,0.62]），必不在会话列表(0.13)一带
    expect(anchor!.x).toBeGreaterThan(717 + 0.3 * 902);
  });

  it("L1：多个候选取最靠底部的一个", () => {
    const higher = block("输入文字", ocrBox(0.4, 0.3, 0.1, 0.028));
    const anchor = ocrInputBarAnchor([...wechatBlocks, higher, PLACEHOLDER], WIN);
    expect(anchor!.y).toBeCloseTo(39 + (1 - 0.12 - 0.028) * 727, 0);
  });

  it("L2：无 placeholder（正在输入草稿）→ 分栏线 + 窗口底缘固定偏移合成锚", () => {
    const anchor = ocrInputBarAnchor(wechatBlocks, WIN);
    expect(anchor).not.toBeNull();
    // y = 窗口底缘 - 固定输入区偏移（120）
    expect(anchor!.y).toBeCloseTo(39 + 727 - 120, 0);
    expect(anchor!.height).toBe(0);
    // x 贴右侧对话区左缘（≥ splitX 下限 0.24）
    expect(anchor!.x).toBeGreaterThanOrEqual(717 + 0.24 * 902 - 1);
    expect(anchor!.x).toBeLessThan(717 + 0.62 * 902);
  });

  it("L2：窗口很矮时 y 不高于窗口中线（clamp 保护）", () => {
    const shortWin = { x: 0, y: 0, width: 800, height: 200 };
    // 无 placeholder、构造可分栏布局（把 y 压扁即可，x 分布沿用）
    const anchor = ocrInputBarAnchor(wechatBlocks, shortWin);
    if (anchor) {
      expect(anchor.y).toBeGreaterThanOrEqual(shortWin.y + shortWin.height / 2);
    }
  });

  it("无 placeholder 且识别不出分栏 → null（交上层 windowFrame 兜底）", () => {
    const sparse = [block("你好", ocrBox(0.4, 0.5, 0.1, 0.03))];
    expect(ocrInputBarAnchor(sparse, WIN)).toBeNull();
  });

  it("windowBounds 退化（零宽高）→ null", () => {
    expect(ocrInputBarAnchor([PLACEHOLDER], { x: 0, y: 0, width: 0, height: 0 })).toBeNull();
  });

  it("blocks 为空 → null", () => {
    expect(ocrInputBarAnchor([], WIN)).toBeNull();
  });
});
