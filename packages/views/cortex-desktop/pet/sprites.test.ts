import { describe, expect, it } from "vitest";
import type { PetKind } from "@cortex-work/core";
import { PET_SPRITES, hasSprites, resolveSpriteAnim, spriteKeyFor } from "./sprites";

describe("sprites manifest", () => {
  it("每个 anim 条目结构合法(frames/fps/尺寸/src/loop)", () => {
    for (const [kind, anims] of Object.entries(PET_SPRITES)) {
      for (const [key, anim] of Object.entries(anims ?? {})) {
        const where = `${kind}.${key}`;
        expect(anim.src, `${where}.src`).toBeTruthy();
        expect(anim.frames, `${where}.frames`).toBeGreaterThanOrEqual(1);
        expect(anim.fps, `${where}.fps`).toBeGreaterThan(0);
        expect(anim.frameW, `${where}.frameW`).toBeGreaterThan(0);
        expect(anim.frameH, `${where}.frameH`).toBeGreaterThan(0);
        expect([true, false, "pingpong"], `${where}.loop`).toContain(anim.loop);
      }
    }
  });

  it("cat 含三个核心态资产", () => {
    expect(Object.keys(PET_SPRITES.cat ?? {}).sort()).toEqual(["happy", "idle", "sleeping"]);
  });

  it("mint 含三个核心态资产,帧数比 cat/dog 少但仍合法", () => {
    expect(Object.keys(PET_SPRITES.mint ?? {}).sort()).toEqual(["happy", "idle", "sleeping"]);
    expect(PET_SPRITES.mint?.idle?.frames).toBe(3);
    expect(PET_SPRITES.mint?.sleeping?.frames).toBe(2);
  });
});

describe("hasSprites", () => {
  it("cat / dog / mint 均有 sprite", () => {
    expect(hasSprites("cat")).toBe(true);
    expect(hasSprites("dog")).toBe(true);
    expect(hasSprites("mint")).toBe(true);
  });
});

describe("spriteKeyFor", () => {
  it("按状态映射,信息性状态复用 idle", () => {
    expect(spriteKeyFor("happy")).toBe("happy");
    expect(spriteKeyFor("sleeping")).toBe("sleeping");
    expect(spriteKeyFor("idle")).toBe("idle");
    expect(spriteKeyFor("typing")).toBe("idle");
    expect(spriteKeyFor("thinking")).toBe("idle");
    expect(spriteKeyFor("working")).toBe("idle");
    expect(spriteKeyFor("replying")).toBe("idle");
  });
});

describe("resolveSpriteAnim", () => {
  it("cat 各状态解析到对应 anim", () => {
    expect(resolveSpriteAnim("cat", "idle")?.frames).toBe(4);
    expect(resolveSpriteAnim("cat", "happy")?.frames).toBe(5);
    expect(resolveSpriteAnim("cat", "sleeping")).toBe(PET_SPRITES.cat?.sleeping);
  });

  it("信息性状态回退 cat.idle", () => {
    expect(resolveSpriteAnim("cat", "typing")).toBe(PET_SPRITES.cat?.idle);
    expect(resolveSpriteAnim("cat", "working")).toBe(PET_SPRITES.cat?.idle);
  });

  it("dog 各状态解析到对应 anim", () => {
    expect(resolveSpriteAnim("dog", "idle")?.frames).toBe(4);
    expect(resolveSpriteAnim("dog", "happy")?.frames).toBe(5);
  });

  it("mint 各状态解析到对应 anim(帧数较少但结构一致)", () => {
    expect(resolveSpriteAnim("mint", "idle")?.frames).toBe(3);
    expect(resolveSpriteAnim("mint", "happy")).toBe(PET_SPRITES.mint?.happy);
    expect(resolveSpriteAnim("mint", "sleeping")).toBe(PET_SPRITES.mint?.sleeping);
  });

  it("manifest 中无该角色时返回 null(防御性,交由 SVG 兜底)", () => {
    // 真实角色(cat/dog)均有 sprite;用越界 kind 覆盖 `if (!map) return null` 分支
    expect(resolveSpriteAnim("ghost" as PetKind, "idle")).toBeNull();
  });
});
