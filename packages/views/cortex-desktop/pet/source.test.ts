import { describe, expect, it } from "vitest";
import type { PetSpriteSource } from "@cortex-work/core/desktop/petdex-types";
import { PETDEX_CELL_H, PETDEX_CELL_W } from "@cortex-work/core/pet/grid";
import { ROW_FALLBACK, SLEEP_SLOWDOWN, resolveRow } from "./rows";
import { BUILTIN_CELL_H, BUILTIN_CELL_W } from "./sheets";
import { resolveSheet } from "./source";

const petdex = (over: Partial<PetSpriteSource> = {}): PetSpriteSource => ({
  origin: "petdex",
  id: "homelander",
  url: "cortex-petdex://sprite/homelander.webp?v=abc",
  cols: 8,
  rows: 9,
  displayName: "Homelander",
  ...over,
});

describe("resolveRow", () => {
  // 这是修掉参考实现越界 bug 的核心:8 行的 sprite 上 review(行 8)必须回落。
  it("8 行 sprite 上 thinking 回落到 running(7),不返回越界的 8", () => {
    expect(resolveRow(ROW_FALLBACK.thinking, 8)).toBe(7);
  });

  it("9 行 sprite 上 thinking 用 review(8)", () => {
    expect(resolveRow(ROW_FALLBACK.thinking, 9)).toBe(8);
  });

  it("链上全部越界时钳到 idle 行", () => {
    expect(resolveRow(ROW_FALLBACK.thinking, 1)).toBe(0);
    expect(resolveRow([8, 7], 1)).toBe(0);
  });

  it("每个姿态的降级链最终都能落到合法行", () => {
    for (const [state, chain] of Object.entries(ROW_FALLBACK)) {
      for (const rows of [1, 8, 9, 11]) {
        const row = resolveRow(chain, rows);
        expect(row, `${state} @ ${rows} 行`).toBeLessThan(rows);
      }
    }
  });
});

describe("resolveSheet — 内置角色", () => {
  it("sprite 为 null 时回落内置(首启/离线的保证)", () => {
    const sheet = resolveSheet(null, "idle");
    expect(sheet).toMatchObject({ row: 0, frames: 4, cellW: BUILTIN_CELL_W, cellH: BUILTIN_CELL_H });
  });

  it("内置资产每个动作一张单行 sheet,恒取 row 0", () => {
    for (const state of ["idle", "happy", "sleeping", "thinking", "failed"] as const) {
      expect(resolveSheet(null, state)!.row, state).toBe(0);
    }
  });

  it("信息性姿态复用 idle 资产", () => {
    const idle = resolveSheet(null, "idle")!;
    for (const state of ["typing", "thinking", "working", "replying", "waiting", "failed"] as const) {
      expect(resolveSheet(null, state)!.url, state).toBe(idle.url);
    }
  });

  it("happy 是一次性动画,idle 不是", () => {
    expect(resolveSheet(null, "happy")!.oneShot).toBe(true);
    expect(resolveSheet(null, "idle")!.oneShot).toBe(false);
  });
});

describe("resolveSheet — petdex", () => {
  it("按格子尺寸与降级链取帧", () => {
    const sheet = resolveSheet(petdex(), "thinking")!;
    expect(sheet).toMatchObject({ row: 8, cellW: PETDEX_CELL_W, cellH: PETDEX_CELL_H });
  });

  it("8 行 sprite 的 thinking 落到 7 行而非越界", () => {
    expect(resolveSheet(petdex({ rows: 8 }), "thinking")!.row).toBe(7);
  });

  // 实测 idle 行只有 6 帧非空(第 7、8 列全透明),多播会让宠物凭空消失。
  it("帧数取 min(6, 列数)", () => {
    expect(resolveSheet(petdex({ cols: 8 }), "idle")!.frames).toBe(6);
    expect(resolveSheet(petdex({ cols: 3 }), "idle")!.frames).toBe(3);
  });

  it("缺 url / 网格非法时返回 null(交由外层渲染空白而不是画坏图)", () => {
    expect(resolveSheet(petdex({ url: null }), "idle")).toBeNull();
    expect(resolveSheet(petdex({ cols: 0 }), "idle")).toBeNull();
    expect(resolveSheet(petdex({ rows: 0 }), "idle")).toBeNull();
  });

  it("key 绑定到「图 + 行」:同一行的不同姿态不重置帧游标", () => {
    // typing 与 waiting 都映射到行 6
    expect(resolveSheet(petdex(), "typing")!.key).toBe(resolveSheet(petdex(), "waiting")!.key);
    expect(resolveSheet(petdex(), "idle")!.key).not.toBe(resolveSheet(petdex(), "thinking")!.key);
  });
});

describe("sleeping 的慢放", () => {
  it("帧间隔按 SLEEP_SLOWDOWN 倍数放慢(复用 idle 行,不画假帧)", () => {
    const idle = resolveSheet(petdex(), "idle")!;
    const sleeping = resolveSheet(petdex(), "sleeping")!;
    expect(sleeping.row).toBe(idle.row); // petdex 没有睡眠行
    expect(sleeping.frameMs).toBe(idle.frameMs * SLEEP_SLOWDOWN);
  });
});
