// Task 0 技术验证回归测试:HTML → 场景提取 → PPTX 混合导出。
// 真实渲染由独立 Electron 子进程完成(vitest 的 Node 环境没有布局引擎):
//   beforeAll 里 `electron poc/harness.cjs fixtures/ <outDir>` 跑出 4 个 fixture 的
//   scene.json + full/base 截图,随后的断言全部基于这些产物与 PPTX XML 结构。
// 退出条件对应关系:
//   - 文本/图片/表格可编辑 → slide XML 中存在原生 <a:t>/<a:blip>/<a:tbl>;
//   - 复杂层明确降级且不重复渲染 → raster 节点有原因、base raster 中原生内容已被隐藏
//     (baseNonBackgroundRatio 显著低于 fullNonBackgroundRatio);
//   - 边界/字体/颜色/z-order 正确 → scene.json 数值断言。
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import { scenesToPptxBuffer, pxToIn, pxToPt } from "./poc/scene-to-pptx";
import { summarizeScene } from "./poc/scene-types";
import type { SceneImageNode, SceneShapeNode, SceneTableNode, SceneTextNode, SlideScene } from "./poc/scene-types";

const execFileAsync = promisify(execFile);

const here = fileURLToPath(new URL(".", import.meta.url));
const fixturesDir = join(here, "fixtures");
const harnessPath = join(here, "poc", "harness.cjs");

// electron 包在 Node 环境 require 时返回二进制路径字符串。
const nodeRequire = createRequire(import.meta.url);
const electronBin = nodeRequire("electron") as unknown as string;

/** harness 产出的 scene.json 附加 meta(截图非背景像素占比)。 */
interface HarnessScene extends SlideScene {
  meta: {
    fullNonBackgroundRatio: number;
    baseNonBackgroundRatio: number;
    capturedSize: { width: number; height: number };
  };
}

const FIXTURES = ["01-text-blocks", "02-images", "03-table", "04-complex"] as const;

let outDir: string;
const scenes = new Map<string, HarnessScene>();
let pptxBuffer: Buffer;
let slideXml: string[] = [];
let mediaNames: string[] = [];

// 读 harness 产出的 base raster 截图为 data URI(作为复杂层底图喂给转换器)。
function baseRasterDataUri(name: string): string {
  const png = readFileSync(join(outDir, `${name}.base.png`));
  return `data:image/png;base64,${png.toString("base64")}`;
}

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "cortex-slides-poc-"));
  // 剔除 ELECTRON_RUN_AS_NODE,确保 electron 以完整 GUI runtime 启动。
  const { ELECTRON_RUN_AS_NODE: _drop, ...env } = process.env;
  await execFileAsync(electronBin, [harnessPath, fixturesDir, outDir], {
    env,
    timeout: 90_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  // app.exit 退出码在 macOS 下不可靠,以 done.json 标记判定 harness 是否全量完成。
  const done = JSON.parse(readFileSync(join(outDir, "done.json"), "utf8")) as { done: string[] };
  expect(done.done).toEqual([...FIXTURES]);
  for (const name of FIXTURES) {
    scenes.set(name, JSON.parse(readFileSync(join(outDir, `${name}.scene.json`), "utf8")) as HarnessScene);
  }

  // 四页合成一个 PPTX,并解包 slide XML 供结构断言。
  const { buffer } = await scenesToPptxBuffer(
    FIXTURES.map((name) => {
      const scene = scenes.get(name)!;
      return {
        scene,
        baseRasterDataUri: scene.hasComplexLayers ? baseRasterDataUri(name) : undefined,
      };
    }),
  );
  pptxBuffer = buffer;
  const deckPath = join(outDir, "poc-deck.pptx");
  await writeFile(deckPath, pptxBuffer);
  // 保留产物路径,便于人工用 PowerPoint / Keynote 验证可编辑性。
  console.info(`[slides-poc] deck written to ${deckPath}`);

  const zip = await JSZip.loadAsync(pptxBuffer);
  slideXml = await Promise.all(
    FIXTURES.map((_, i) => zip.file(`ppt/slides/slide${i + 1}.xml`)!.async("string")),
  );
  mediaNames = Object.keys(zip.files).filter((f) => f.startsWith("ppt/media/"));
}, 120_000);

function sceneOf(name: (typeof FIXTURES)[number]): HarnessScene {
  const scene = scenes.get(name);
  if (!scene) throw new Error(`scene missing for ${name}`);
  return scene;
}

describe("fixture 01 文本与色块", () => {
  it("标题重建为原生文本:边界、字号、加粗、颜色", () => {
    const scene = sceneOf("01-text-blocks");
    const title = scene.nodes.find(
      (n): n is SceneTextNode => n.kind === "text" && n.runs.some((r) => r.text.includes("AI Slides 技术验证")),
    );
    expect(title).toBeDefined();
    expect(title!.x).toBeCloseTo(80, 0);
    expect(title!.y).toBeCloseTo(80, 0);
    expect(title!.w).toBeCloseTo(800, 0);
    expect(title!.runs[0].fontSizePx).toBeCloseTo(48, 1);
    expect(title!.runs[0].bold).toBe(true);
    expect(title!.runs[0].color).toBe("0f172a");
  });

  it("段落内样式片段拆为独立 run:加粗、彩色、强制换行", () => {
    const scene = sceneOf("01-text-blocks");
    const para = scene.nodes.find(
      (n): n is SceneTextNode => n.kind === "text" && n.runs.some((r) => r.text.includes("普通段落文字")),
    );
    expect(para).toBeDefined();
    expect(para!.runs.some((r) => r.text.includes("加粗片段") && r.bold)).toBe(true);
    expect(para!.runs.some((r) => r.text.includes("彩色片段") && r.color === "e2444a")).toBe(true);
    expect(para!.runs.some((r) => r.breakAfter === true)).toBe(true);
  });

  it("纯色块与带边框徽章重建为原生 shape,z-order 在文字之下", () => {
    const scene = sceneOf("01-text-blocks");
    const block = scene.nodes.find((n): n is SceneShapeNode => n.kind === "shape" && n.fill === "2b6cb0");
    expect(block).toBeDefined();
    expect(block!.x).toBeCloseTo(80, 0);
    expect(block!.y).toBeCloseTo(340, 0);
    expect(block!.w).toBeCloseTo(320, 0);
    expect(block!.h).toBeCloseTo(200, 0);
    expect(block!.borderRadiusPx).toBeCloseTo(16, 1);

    const badgeShape = scene.nodes.find((n): n is SceneShapeNode => n.kind === "shape" && n.fill === "ecfdf5");
    expect(badgeShape).toBeDefined();
    expect(badgeShape!.border?.color).toBe("10b981");
    const badgeText = scene.nodes.find(
      (n): n is SceneTextNode => n.kind === "text" && n.runs.some((r) => r.text.includes("带边框的文字徽章")),
    );
    expect(badgeText).toBeDefined();
    expect(badgeText!.align).toBe("center");
    // 背景 shape 先于其内文字绘制。
    expect(badgeShape!.z).toBeLessThan(badgeText!.z);
  });

  it("右对齐斜体文本保留对齐与字体样式", () => {
    const scene = sceneOf("01-text-blocks");
    const note = scene.nodes.find(
      (n): n is SceneTextNode => n.kind === "text" && n.runs.some((r) => r.text.includes("右对齐斜体")),
    );
    expect(note).toBeDefined();
    expect(note!.align).toBe("right");
    expect(note!.runs[0].italic).toBe(true);
  });

  it("整页 0 栅格,页面背景为纯色,base raster 接近空白(无重复渲染)", () => {
    const scene = sceneOf("01-text-blocks");
    const report = summarizeScene(scene);
    expect(report.rasterCount).toBe(0);
    expect(scene.hasComplexLayers).toBe(false);
    expect(scene.backgroundColor).toBe("f8fafc");
    expect(scene.meta.baseNonBackgroundRatio).toBeLessThan(0.02);
    expect(scene.meta.fullNonBackgroundRatio).toBeGreaterThan(scene.meta.baseNonBackgroundRatio);
  });
});

describe("fixture 02 图片", () => {
  it("data URI 图片重建为原生图片节点,几何正确", () => {
    const scene = sceneOf("02-images");
    const images = scene.nodes.filter((n): n is SceneImageNode => n.kind === "image");
    expect(images).toHaveLength(2);
    expect(images.every((img) => img.src.startsWith("data:image/png;base64,"))).toBe(true);
    const plain = images.find((img) => Math.abs(img.x - 100) < 1);
    expect(plain).toBeDefined();
    expect(plain!.y).toBeCloseTo(160, 0);
    expect(plain!.w).toBeCloseTo(240, 0);
    expect(plain!.h).toBeCloseTo(160, 0);
    const rounded = images.find((img) => (img.borderRadiusPx ?? 0) > 0);
    expect(rounded).toBeDefined();
    expect(rounded!.borderRadiusPx).toBeCloseTo(12, 1);
  });

  it("图片页无栅格降级", () => {
    expect(summarizeScene(sceneOf("02-images")).rasterCount).toBe(0);
  });
});

describe("fixture 03 表格", () => {
  it("表格重建为原生 table:行列、表头样式、对齐、边框", () => {
    const scene = sceneOf("03-table");
    const table = scene.nodes.find((n): n is SceneTableNode => n.kind === "table");
    expect(table).toBeDefined();
    expect(table!.rows).toHaveLength(3);
    expect(table!.rows[0].map((c) => c.text)).toEqual(["指标", "第一季度", "第二季度"]);
    expect(table!.rows[0].every((c) => c.bold)).toBe(true);
    expect(table!.rows[0][0].fill).toBe("f1f5f9");
    expect(table!.rows[1][1].text).toBe("12,480");
    expect(table!.rows[1][1].align).toBe("right");
    expect(table!.border?.color).toBe("cbd5e1");
    expect(table!.colWidthsPx).toHaveLength(3);
    expect(table!.w).toBeCloseTo(1000, 0);
  });
});

describe("fixture 04 复杂层", () => {
  it("canvas / 滤镜 / 渐变背景全部明确降级并给出原因", () => {
    const scene = sceneOf("04-complex");
    expect(scene.hasComplexLayers).toBe(true);
    expect(scene.backgroundColor).toBeUndefined();
    const reasons = summarizeScene(scene).rasterReasons;
    expect(reasons).toContain("body-background");
    expect(reasons).toContain("canvas");
    expect(reasons).toContain("css-filter");
  });

  it("普通标题仍原生重建,base raster 已剔除原生文字(不重复渲染)", () => {
    const scene = sceneOf("04-complex");
    const title = scene.nodes.find(
      (n): n is SceneTextNode => n.kind === "text" && n.runs.some((r) => r.text.includes("复杂视觉层降级验证")),
    );
    expect(title).toBeDefined();
    expect(title!.runs[0].color).toBe("f8fafc");
    // 渐变背景占满全页 → base 非背景占比高;隐藏了标题后 base 应低于 full。
    expect(scene.meta.baseNonBackgroundRatio).toBeGreaterThan(0.05);
    expect(scene.meta.baseNonBackgroundRatio).toBeLessThan(scene.meta.fullNonBackgroundRatio + 0.001);
  });
});

describe("PPTX 结构(可编辑性与不重复渲染)", () => {
  it("文本页:标题/加粗 run 是原生 <a:t> 文本(PowerPoint 可选中编辑)", () => {
    expect(slideXml[0]).toContain("<a:t>AI Slides 技术验证</a:t>");
    expect(slideXml[0]).toContain('b="1"');
    // 圆角色块为原生 roundRect 形状。
    expect(slideXml[0]).toContain('prst="roundRect"');
    // 页面背景为纯色 slide background。
    expect(slideXml[0]).toContain("F8FAFC");
  });

  it("图片页:两张图片作为原生 pic + 媒体文件落包", () => {
    const picCount = (slideXml[1].match(/<p:pic>/g) ?? []).length;
    expect(picCount).toBe(2);
    expect(mediaNames.length).toBeGreaterThanOrEqual(2);
  });

  it("表格页:原生 <a:tbl>,单元格文本可编辑", () => {
    expect(slideXml[2]).toContain("<a:tbl>");
    expect(slideXml[2]).toContain("<a:t>指标</a:t>");
    expect(slideXml[2]).toContain("<a:t>12,480</a:t>");
  });

  it("复杂页:base raster 单张 + 原生标题,栅格区域不再落独立对象", () => {
    const picCount = (slideXml[3].match(/<p:pic>/g) ?? []).length;
    expect(picCount).toBe(1);
    expect(slideXml[3]).toContain("<a:t>复杂视觉层降级验证</a:t>");
  });

  it("px→inch/pt 映射符合 96dpi 与 CSS pt 换算", () => {
    expect(pxToIn(1280)).toBeCloseTo(13.333, 2);
    expect(pxToIn(720)).toBeCloseTo(7.5, 2);
    expect(pxToPt(48)).toBe(36);
  });
});

// LibreOffice 存在时做一次真实打开验证(headless 转 PDF 成功即视为文件结构可被第三方软件解析)。
const soffice = ["/Applications/LibreOffice.app/Contents/MacOS/soffice", "/usr/local/bin/soffice"].find((p) =>
  existsSync(p),
);

describe.skipIf(!soffice)("LibreOffice 兼容性(可选)", () => {
  it("headless 打开导出的 PPTX 并转换 PDF 成功", async () => {
    await execFileAsync(soffice!, ["--headless", "--convert-to", "pdf", "--outdir", outDir, join(outDir, "poc-deck.pptx")], {
      timeout: 120_000,
    });
    expect(existsSync(join(outDir, "poc-deck.pdf"))).toBe(true);
  }, 150_000);
});
