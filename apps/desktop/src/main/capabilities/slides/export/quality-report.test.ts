import { describe, expect, it, vi } from "vitest";

import { extractSlideScene } from "./dom-extractor";
import { summarizeScene } from "./types";
import type { SlideScene } from "./types";

function scene(overrides: Partial<SlideScene> = {}): SlideScene {
  return {
    width: 1280,
    height: 720,
    backgroundColor: "ffffff",
    hasComplexLayers: false,
    warnings: [],
    nodes: [],
    ...overrides,
  };
}

describe("summarizeScene", () => {
  it("给 desktop export 场景补齐 quality / nativeKinds / rasterAreaRatio", () => {
    const report = summarizeScene(
      scene({
        nodes: [
          {
            kind: "text",
            id: "text-1",
            x: 100,
            y: 80,
            w: 600,
            h: 60,
            z: 0,
            align: "left",
            lineHeightPx: 60,
            paddingPx: { top: 0, right: 0, bottom: 0, left: 0 },
            runs: [{ text: "标题", fontFamily: "Helvetica", fontSizePx: 48, color: "0f172a", bold: true, italic: false, underline: false }],
          },
          {
            kind: "shape",
            id: "shape-1",
            x: 80,
            y: 60,
            w: 640,
            h: 100,
            z: -1,
            fill: "ffffff",
          },
          {
            kind: "raster",
            id: "raster-1",
            x: 0,
            y: 0,
            w: 1280,
            h: 720,
            z: -2,
            reason: "body-background",
          },
        ],
      })
    );

    expect(report.nativeKinds).toEqual({ text: 1, image: 0, table: 0, shape: 1, chart: 0 });
    expect(report.rasterAreaRatio).toBe(1);
    expect(report.quality).toBe("raster-heavy");
  });

  it("blocking/mixed-content warning 会被脱敏保留,并把质量判为 raster-heavy", () => {
    const report = summarizeScene(
      scene({
        nodes: [
          {
            kind: "raster",
            id: "raster-1",
            x: 40,
            y: 60,
            w: 320,
            h: 160,
            z: 0,
            reason: "mixed-content",
          },
        ],
        warnings: [
          "blocking:slot-007:mixed-content",
          "mixed-content:slot-007:hero-text",
        ],
      })
    );

    expect(report.rasterReasons).toEqual(["mixed-content"]);
    expect(report.warnings).toEqual(["blocking", "mixed-content"]);
    expect(report.quality).toBe("raster-heavy");
  });
});

describe("extractSlideScene chart candidate keys", () => {
  it("用独立 candidate key 回写 chart 标记,避免引号/重复 data-cortex-id 污染 querySelector", async () => {
    const quotedDuplicateId = 'chart "north-region" '.repeat(8).trim();
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce({
        width: 1280,
        height: 720,
        backgroundColor: "ffffff",
        hasComplexLayers: false,
        warnings: [],
        nodes: [
          {
            kind: "chart-candidate",
            id: "chart-1",
            candidateKey: "chart-candidate-1",
            chartId: quotedDuplicateId,
            x: 60,
            y: 80,
            w: 260,
            h: 180,
            z: 0,
            specText:
              '{"version":1,"type":"bar","categories":["Q1"],"series":[{"name":"收入","values":[12],"color":"#3366FF"}]}',
          },
          {
            kind: "chart-candidate",
            id: "chart-2",
            candidateKey: "chart-candidate-2",
            chartId: quotedDuplicateId,
            x: 360,
            y: 80,
            w: 260,
            h: 180,
            z: 1,
            specText:
              '{"version":1,"type":"line","categories":["Q1"],"series":[{"name":"激活率","values":[42],"color":"#10B981"}]}',
          },
        ],
      } as never)
      .mockResolvedValueOnce(undefined);

    const win = {
      executeJavaScript,
      insertCSS: vi.fn(),
      capturePage: vi.fn(),
      loadURL: vi.fn(),
      destroy: vi.fn(),
      isDestroyed: vi.fn(() => false),
    };

    const extracted = await extractSlideScene(win as never);

    expect(extracted.nodes.filter((node) => node.kind === "chart")).toHaveLength(2);
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
    const mutationScript = executeJavaScript.mock.calls[1]?.[0];
    expect(mutationScript).toContain('"chart-candidate-1"');
    expect(mutationScript).toContain('"chart-candidate-2"');
    expect(mutationScript).not.toContain(quotedDuplicateId);
  });
});
