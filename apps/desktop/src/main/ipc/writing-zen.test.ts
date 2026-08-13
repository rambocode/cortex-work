// 写作禅模式资产服务单测:对仓库内真实 resources/zen 目录验证枚举与按 id 取路径
// (含防目录穿越)。窗口编排(幕布/simple fullscreen/绿灯)依赖真 electron 环境,不在单测范围。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assetPathById, computeZenBounds, listAssetIds } from "./writing-zen";

const ZEN_ROOT = join(__dirname, "..", "..", "..", "resources", "zen");
const BG_DIR = join(ZEN_ROOT, "backgrounds");
const SOUND_DIR = join(ZEN_ROOT, "sounds");

describe("zen 资产枚举", () => {
  it("背景/环境音目录随仓库存在且非空(Metion 资源已拷入)", async () => {
    const bgs = await listAssetIds(BG_DIR, [".jpg", ".jpeg", ".png"]);
    const sounds = await listAssetIds(SOUND_DIR, [".mp3", ".m4a"]);
    expect(bgs.length).toBeGreaterThan(0);
    expect(sounds).toContain("morning_bird"); // 晨莺,渲染端默认背景音
    // id 是去后缀的文件名且排序稳定。
    expect(bgs.every((id) => !/\.(jpe?g|png)$/i.test(id))).toBe(true);
    expect([...bgs].sort()).toEqual(bgs);
  });

  it("目录缺失回空表", async () => {
    expect(await listAssetIds(join(ZEN_ROOT, "no-such-dir"), [".mp3"])).toEqual([]);
  });

  it("禅模式衬线字体(思源宋体 Light)随包存在 —— writing:zenFontData 的资产前提", async () => {
    const fonts = await listAssetIds(join(ZEN_ROOT, "fonts"), [".otf"]);
    expect(fonts).toContain("SourceHanSerifCN-Light");
  });
});

describe("computeZenBounds(禅模式窗口最佳比例:宽屏横构图)", () => {
  it("大屏:宽封顶 1320,高 = 宽 × 0.6,居中", () => {
    const wa = { x: 0, y: 25, width: 2560, height: 1415 };
    const b = computeZenBounds(wa);
    expect(b.width).toBe(1320); // min(1320, max(900, 2560*0.52=1331.2))
    expect(b.height).toBe(Math.round(1320 * 0.6));
    expect(b.x).toBe(Math.round((2560 - b.width) / 2));
    expect(b.y).toBe(Math.round(25 + (1415 - b.height) / 2));
  });

  it("中屏:宽走下限 900(容纳 720 版心 + 呼吸位),高保持 0.6 比例", () => {
    const b = computeZenBounds({ x: 0, y: 25, width: 1280, height: 775 });
    expect(b.width).toBe(900); // max(900, 1280*0.52=665.6)
    expect(b.height).toBe(540); // min(775-96=679, max(520, 900*0.6=540))
  });

  it("小屏兜底:不超出工作区,高下限 520 但上下仍留 96px 幕布", () => {
    const b = computeZenBounds({ x: 0, y: 0, width: 800, height: 620 });
    expect(b.width).toBe(800); // 下限 900 被工作区宽夹住
    expect(b.height).toBe(520); // max(520, 800*0.6=480)=520,未触 620-96=524 上限
    expect(b.x).toBe(0);
    expect(b.y).toBe(50); // (620-520)/2
  });
});

describe("assetPathById", () => {
  it("合法 id 解析到存在的文件;未知 id 回 null", async () => {
    expect(await assetPathById(SOUND_DIR, "rain", [".mp3"])).toContain("rain.mp3");
    expect(await assetPathById(SOUND_DIR, "no-such", [".mp3"])).toBeNull();
  });

  it("拒绝目录穿越与空 id", async () => {
    expect(await assetPathById(SOUND_DIR, "../sounds/rain", [".mp3"])).toBeNull();
    expect(await assetPathById(SOUND_DIR, "a/b", [".mp3"])).toBeNull();
    expect(await assetPathById(SOUND_DIR, "a\\b", [".mp3"])).toBeNull();
    expect(await assetPathById(SOUND_DIR, "", [".mp3"])).toBeNull();
  });
});
