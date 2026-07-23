// buildSpeakerHtml 测试:结构节点(计时器/时钟/提示条/备注容器)、双池 iframe、notes 转义防逃逸、
// 起始页初始定位、末页「演示结束」占位。
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSpeakerHtml, speakerEntranceRuntime } from "./speaker-html";
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

  it("提供基础控制栏和延迟加载的缩略图跳转列表", () => {
    const html = buildSpeakerHtml({ title: "季度汇报", slides: SLIDES, startIndex: 0 });
    expect(html).toContain('id="presenterPrev"');
    expect(html).toContain('id="presenterNext"');
    expect(html).toContain('id="presenterJump"');
    expect(html).toContain('id="presenterEnd"');
    expect(html).toContain('id="slidePicker"');
    expect((html.match(/class="picker-slide"/g) || []).length).toBe(3);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("cortex-presenter://control/");
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

describe("buildSpeakerHtml 动画", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("带动画风格时内嵌入场样式与运行时;缺省 none 不注入", () => {
    const animated = buildSpeakerHtml({
      title: "T",
      slides: [
        {
          ...SLIDES[0]!,
          animation: { entrances: [{ elementId: "t", preset: "fade-up", step: 1 }] },
        },
        SLIDES[1]!,
      ],
      startIndex: 0,
      animationStyle: "lively",
    });
    expect(animated).toContain("@keyframes cortex-anim-fade-up");
    expect(animated).toContain("cortex-anim-hidden");
    // 声明式注解随配置内嵌(fade-up step1 → 分步揭示数据在)。
    expect(animated).toContain('"entrances"');

    const still = buildSpeakerHtml({ title: "T", slides: SLIDES, startIndex: 0 });
    expect(still).not.toContain("@keyframes cortex-anim-");
  });

  it("演讲者预览应用显式 durationMs,与观众窗口保持一致", () => {
    const html = buildSpeakerHtml({
      title: "T",
      slides: [
        {
          ...SLIDES[0]!,
          animation: {
            entrances: [{ elementId: "t", preset: "fade-up", step: 1, durationMs: 1_234 }],
          },
        },
      ],
      startIndex: 0,
      animationStyle: "lively",
    });
    expect(html).toContain('"durationMs":1234');
    expect(html).toContain("entry.el.style.animationDuration");
  });

  it("about:blank 先 load 后跳页,真正 srcdoc load 时仍补做当前页动画同步", () => {
    const listeners = new Map<string, () => void>();
    const frameListeners: Array<() => void> = [];
    const classes = new Set<string>();
    const element = {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        contains: (name: string) => classes.has(name),
      },
      setAttribute: vi.fn(),
      style: { animationDuration: "" },
    };
    const blankDocument = { URL: "about:blank", body: {} };
    const srcdocDocument = {
      URL: "about:srcdoc",
      body: { offsetWidth: 1 },
      head: { appendChild: vi.fn() },
      createElement: vi.fn(() => ({ setAttribute: vi.fn(), textContent: "" })),
      querySelector: vi.fn((selector: string) =>
        selector === "style[data-cortex-anim-css]" ? {} : element
      ),
    };
    const frames = [0, 1].map(() => ({
      contentDocument: blankDocument as unknown as Document,
      addEventListener: (_name: string, callback: () => void) => frameListeners.push(callback),
    }));
    const location = { hash: "#1" };
    vi.stubGlobal("document", { querySelectorAll: () => frames });
    vi.stubGlobal("location", location);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("window", {
      addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
      clearTimeout: vi.fn(),
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
    });

    speakerEntranceRuntime(
      {
        style: "lively",
        slides: [null, { entrances: [{ elementId: "target", preset: "fade-up", step: 0 }] }],
        entranceCss: "",
      },
      () => [],
      undefined,
      () => []
    );
    frameListeners[1]!();
    location.hash = "#2";
    listeners.get("hashchange")!();
    frames[1]!.contentDocument = srcdocDocument as unknown as Document;
    frameListeners[1]!();

    expect(classes.has("cortex-anim-enter-fade-up")).toBe(true);
  });
});
