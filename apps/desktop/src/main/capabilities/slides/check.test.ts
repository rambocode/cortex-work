// 检查规则单测:静态规则(远程资源/危险导航/密度/空页)与渲染巡检映射
// (越界/裁切/最小字号/图片失败/空截图),finding id 稳定可重跑。
import { describe, expect, it } from "vitest";
import {
  renderInspectionFindings,
  sortFindings,
  staticCheckSlideHtml,
  TEXT_DENSITY_WARN_CHARS,
} from "./check";
import type { SlideRenderInspection } from "./render";

const GOOD_HTML = `<!doctype html>
<html><head><meta charset="utf-8" /></head>
<body style="width:1280px;height:720px"><h1 data-cortex-id="t">标题</h1></body></html>`;

function inspection(overrides: Partial<SlideRenderInspection> = {}): SlideRenderInspection {
  return {
    overflowX: false,
    overflowY: false,
    clipped: [],
    smallText: [],
    brokenImages: [],
    visibleTextLength: 40,
    hasVisibleContent: true,
    ...overrides,
  };
}

describe("staticCheckSlideHtml", () => {
  it("干净页面无 finding", () => {
    expect(staticCheckSlideHtml("slot-001", GOOD_HTML)).toEqual([]);
  });

  it("远程 JS 为 blocking,远程图片为 warning", () => {
    const html = `<!doctype html><html><head><meta charset="utf-8" /></head><body>
      <script src="https://cdn.example.com/x.js"></script>
      <img src="https://img.example.com/a.png" /></body></html>`;
    const findings = staticCheckSlideHtml("slot-001", html);
    expect(findings.find((f) => f.code === "remote-script")?.severity).toBe("blocking");
    expect(findings.find((f) => f.code === "remote-resource")?.severity).toBe("warning");
  });

  it("危险导航与外链", () => {
    const html = `<!doctype html><html><head><meta charset="utf-8" /></head><body>
      <a target="_blank" href="x">out</a><script>window.open('x')</script></body></html>`;
    const codes = staticCheckSlideHtml("slot-001", html).map((f) => f.code);
    expect(codes).toContain("dangerous-navigation");
    expect(codes).toContain("external-link");
  });

  it("缺 doctype/charset 与文本密度", () => {
    const html = `<html><body>${"字".repeat(TEXT_DENSITY_WARN_CHARS + 1)}</body></html>`;
    const codes = staticCheckSlideHtml("slot-001", html).map((f) => f.code);
    expect(codes).toContain("missing-doctype");
    expect(codes).toContain("missing-charset");
    expect(codes).toContain("text-density");
  });

  it("finding id 稳定(同页同规则重跑一致)", () => {
    const html = `<html><body>x</body></html>`;
    const a = staticCheckSlideHtml("slot-001", html).map((f) => f.id);
    const b = staticCheckSlideHtml("slot-001", html).map((f) => f.id);
    expect(a).toEqual(b);
  });

  it("canvas 缺 chart spec 或 spec 非法时给出可编辑性 warning", () => {
    const missing = staticCheckSlideHtml("slot-001", GOOD_HTML.replace("</body>", "<canvas></canvas></body>"));
    expect(missing.map((item) => item.code)).toContain("chart-spec-missing");

    const invalid = staticCheckSlideHtml(
      "slot-001",
      GOOD_HTML.replace(
        "</body>",
        '<script type="application/json" data-cortex-chart-spec>{"version":1,"type":"bar"}</script><canvas></canvas></body>',
      ),
    );
    expect(invalid.map((item) => item.code)).toContain("chart-spec-invalid");

    const valid = staticCheckSlideHtml(
      "slot-001",
      GOOD_HTML.replace(
        "</body>",
        '<script type="application/json" data-cortex-chart-spec>{"version":1,"type":"bar","categories":["Q1"],"series":[{"name":"收入","values":[12]}]}</script><canvas></canvas></body>',
      ),
    );
    expect(valid.map((item) => item.code)).not.toContain("chart-spec-missing");
    expect(valid.map((item) => item.code)).not.toContain("chart-spec-invalid");
  });
});

describe("renderInspectionFindings", () => {
  it("干净巡检无 finding", () => {
    expect(renderInspectionFindings("slot-001", inspection(), 0.4)).toEqual([]);
  });

  it("越界/裁切/小字号/坏图/空页映射", () => {
    const findings = renderInspectionFindings(
      "slot-001",
      inspection({
        overflowY: true,
        clipped: [{ id: "hero", x: 1200, y: 700, w: 300, h: 100 }],
        smallText: [{ id: "note", fontSizePx: 10 }],
        brokenImages: [{ id: "img1", src: "data:..." }],
        hasVisibleContent: false,
      }),
      0.999,
    );
    const byCode = new Map(findings.map((f) => [f.code, f]));
    expect(byCode.get("overflow")?.severity).toBe("blocking");
    expect(byCode.get("clipped")?.elementId).toBe("hero");
    expect(byCode.get("min-font-size")?.severity).toBe("warning");
    expect(byCode.get("image-load-failure")?.severity).toBe("blocking");
    expect(byCode.get("empty-slide")?.severity).toBe("blocking");
  });

  it("sortFindings:blocking 优先,再按 slide 顺序", () => {
    const findings = [
      ...renderInspectionFindings("slot-002", inspection({ smallText: [{ id: "a", fontSizePx: 9 }] }), 0),
      ...renderInspectionFindings("slot-001", inspection({ overflowX: true }), 0),
    ];
    const sorted = sortFindings(
      findings,
      new Map([
        ["slot-001", 0],
        ["slot-002", 1],
      ]),
    );
    expect(sorted[0]!.code).toBe("overflow");
    expect(sorted.at(-1)!.code).toBe("min-font-size");
  });
});
