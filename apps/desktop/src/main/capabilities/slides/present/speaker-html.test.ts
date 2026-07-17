// buildSpeakerHtml 测试:结构节点(计时器/时钟/提示条/备注容器)、双池 iframe、notes 转义防逃逸、
// 起始页初始定位、末页「演示结束」占位。
import { describe, expect, it } from "vitest";
import { buildSpeakerHtml } from "./speaker-html";
import type { PresenterSlide } from "../export/html";

const SLIDES: PresenterSlide[] = [
  { title: "开场", html: "<!doctype html><html><body>P1</body></html>", notes: "讲稿一" },
  { title: "论证", html: "<!doctype html><html><body>P2</body></html>" },
  { title: "收尾", html: "<!doctype html><html><body>P3</body></html>" },
];

describe("buildSpeakerHtml", () => {
  it("含演讲者视图的核心结构节点", () => {
    const html = buildSpeakerHtml({ title: "季度汇报", slides: SLIDES, startIndex: 0 });
    expect(html).toContain('id="deckTitle"');
    expect(html).toContain('id="counter"');
    expect(html).toContain('id="elapsed"'); // 已用时间(计时器)
    expect(html).toContain('id="clock"'); // 当前时钟
    expect(html).toContain('id="notes"'); // 备注容器
    expect(html).toContain('id="hintbar"'); // 底部提示条
    expect(html).toContain("← → 翻页 · Esc 结束演示");
    expect(html).toContain("季度汇报");
  });

  it("每页各出现在 current 池与 next 池(两份 iframe)", () => {
    const html = buildSpeakerHtml({ title: "T", slides: SLIDES, startIndex: 0 });
    expect((html.match(/class="cur-slide"/g) || []).length).toBe(3);
    expect((html.match(/class="next-slide"/g) || []).length).toBe(3);
    expect(html).toContain("P1");
    expect(html).toContain("P3");
    // 末页无下一张 → 「演示结束」占位。
    expect(html).toContain('id="nextEnd"');
    expect(html).toContain("演示结束");
  });

  it("备注含 <script> 与引号时被转义,不逃逸出属性", () => {
    const evil: PresenterSlide[] = [
      { title: "X", html: "<p>hi</p>", notes: '"><script>alert(1)</script>' },
    ];
    const html = buildSpeakerHtml({ title: "T", slides: evil, startIndex: 0 });
    // 原始未转义的 <script> 注入不得出现;转义实体应存在。
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
  });

  it("startIndex 体现在初始定位:运行时读 location.hash(1 基)", () => {
    const html = buildSpeakerHtml({ title: "T", slides: SLIDES, startIndex: 2 });
    // 初始定位靠 location.hash(由主进程 loadFile 的 hash 提供),运行时读它 → show(n-1)。
    expect(html).toContain("location.hash");
    expect(html).toContain("show(isNaN(initial) ? 0 : initial - 1)");
    // 只被动 hashchange 同步,不监听 keydown(翻页权威在主进程)。
    expect(html).toContain("hashchange");
    expect(html).not.toContain("keydown");
  });
});
