// 写作禅模式资产服务单测:对仓库内真实 resources/zen 目录验证枚举与按 id 取路径
// (含防目录穿越)。窗口编排(幕布/simple fullscreen/绿灯)依赖真 electron 环境,不在单测范围。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assetPathById, listAssetIds } from "./writing-zen";

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
