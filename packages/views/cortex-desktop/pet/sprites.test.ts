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

  it("cat 含四个核心态资产", () => {
    expect(Object.keys(PET_SPRITES.cat ?? {}).sort()).toEqual(["happy", "idle", "sleeping", "walk"]);
  });
});

describe("hasSprites", () => {
  it("cat / dog 均有 sprite", () => {
    expect(hasSprites("cat")).toBe(true);
    expect(hasSprites("dog")).toBe(true);
  });
});

describe("spriteKeyFor", () => {
  it("散步优先于状态", () => {
    expect(spriteKeyFor("idle", true)).toBe("walk");
    expect(spriteKeyFor("happy", true)).toBe("walk");
    expect(spriteKeyFor("sleeping", true)).toBe("walk");
  });

  it("非散步时按状态映射,信息性状态复用 idle", () => {
    expect(spriteKeyFor("happy", false)).toBe("happy");
    expect(spriteKeyFor("sleeping", false)).toBe("sleeping");
    expect(spriteKeyFor("idle", false)).toBe("idle");
    expect(spriteKeyFor("typing", false)).toBe("idle");
    expect(spriteKeyFor("thinking", false)).toBe("idle");
    expect(spriteKeyFor("working", false)).toBe("idle");
    expect(spriteKeyFor("replying", false)).toBe("idle");
  });
});

describe("resolveSpriteAnim", () => {
  it("cat 各状态解析到对应 anim", () => {
    expect(resolveSpriteAnim("cat", "idle", false)?.frames).toBe(4);
    expect(resolveSpriteAnim("cat", "happy", false)?.frames).toBe(5);
    expect(resolveSpriteAnim("cat", "sleeping", false)).toBe(PET_SPRITES.cat?.sleeping);
    expect(resolveSpriteAnim("cat", "idle", true)).toBe(PET_SPRITES.cat?.walk);
  });

  it("信息性状态回退 cat.idle", () => {
    expect(resolveSpriteAnim("cat", "typing", false)).toBe(PET_SPRITES.cat?.idle);
    expect(resolveSpriteAnim("cat", "working", false)).toBe(PET_SPRITES.cat?.idle);
  });

  it("dog 各状态解析到对应 anim", () => {
    expect(resolveSpriteAnim("dog", "idle", false)?.frames).toBe(4);
    expect(resolveSpriteAnim("dog", "happy", false)?.frames).toBe(5);
  });

  it("manifest 中无该角色时返回 null(防御性,交由 SVG 兜底)", () => {
    // 真实角色(cat/dog)均有 sprite;用越界 kind 覆盖 `if (!map) return null` 分支
    expect(resolveSpriteAnim("ghost" as PetKind, "idle", false)).toBeNull();
  });
});
