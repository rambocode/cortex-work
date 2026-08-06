import { describe, expect, it } from "vitest";
import type { PetdexEntry } from "@cortex-work/core/desktop/petdex-types";
import { PAGE_SIZE, filterPets, pageCount, pageOf, samplePets } from "./usePetdexManifest";

const pet = (slug: string, displayName: string, kind: PetdexEntry["kind"] = "character"): PetdexEntry => ({
  slug,
  displayName,
  kind,
  spritesheetUrl: `https://assets.petdex.dev/pets/${slug}/sprite.webp`,
});

const PETS: PetdexEntry[] = [
  pet("homelander", "Homelander"),
  pet("sadaharu", "Sadaharu", "creature"),
  pet("mochi-milk", "Mochi Milk", "creature"),
  pet("nickel-catalog-bridge", "Nickel Catalog Bridge", "object"),
];

describe("filterPets", () => {
  it("无条件时原样返回(避免白白复制 4374 条)", () => {
    expect(filterPets(PETS, { query: "", kind: "all" })).toBe(PETS);
  });

  it("按类别筛选", () => {
    expect(filterPets(PETS, { query: "", kind: "creature" }).map((p) => p.slug)).toEqual([
      "sadaharu",
      "mochi-milk",
    ]);
  });

  // 用户可能记得展示名,也可能记得 slug,两者都要能命中。
  it("关键词同时匹配展示名与 slug", () => {
    expect(filterPets(PETS, { query: "Mochi", kind: "all" }).map((p) => p.slug)).toEqual(["mochi-milk"]);
    expect(filterPets(PETS, { query: "catalog", kind: "all" }).map((p) => p.slug)).toEqual([
      "nickel-catalog-bridge",
    ]);
  });

  it("大小写与首尾空白不敏感", () => {
    expect(filterPets(PETS, { query: "  HOMELANDER ", kind: "all" })).toHaveLength(1);
  });

  it("类别与关键词同时生效", () => {
    expect(filterPets(PETS, { query: "a", kind: "object" }).map((p) => p.slug)).toEqual([
      "nickel-catalog-bridge",
    ]);
  });

  it("无匹配返回空", () => {
    expect(filterPets(PETS, { query: "zzz-nope", kind: "all" })).toEqual([]);
  });
});

describe("分页", () => {
  const many = Array.from({ length: 100 }, (_, i) => pet(`p${i}`, `P${i}`));

  it("按页切片", () => {
    expect(pageOf(many, 0).map((p) => p.slug)[0]).toBe("p0");
    expect(pageOf(many, 1).map((p) => p.slug)[0]).toBe(`p${PAGE_SIZE}`);
    expect(pageOf(many, 0)).toHaveLength(PAGE_SIZE);
  });

  it("越界页返回空数组而不是抛错", () => {
    expect(pageOf(many, 999)).toEqual([]);
  });

  it("页数至少为 1(空列表也要能渲染分页条)", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(PAGE_SIZE)).toBe(1);
    expect(pageCount(PAGE_SIZE + 1)).toBe(2);
  });
});

describe("samplePets", () => {
  const many = Array.from({ length: 100 }, (_, i) => pet(`p${i}`, `P${i}`));

  it("取够数量且不重复", () => {
    const got = samplePets(many, PAGE_SIZE, 1);
    expect(got).toHaveLength(PAGE_SIZE);
    expect(new Set(got.map((p) => p.slug)).size).toBe(PAGE_SIZE);
  });

  // 「换一批」靠递增 seed,不依赖 Math.random 的调用时机,故同一 seed 结果必须稳定。
  it("同一 seed 结果稳定,不同 seed 结果不同", () => {
    expect(samplePets(many, 8, 3)).toEqual(samplePets(many, 8, 3));
    expect(samplePets(many, 8, 3)).not.toEqual(samplePets(many, 8, 4));
  });

  it("候选不足时原样返回", () => {
    expect(samplePets(PETS, PAGE_SIZE, 1)).toBe(PETS);
  });

  it("空列表不死循环", () => {
    expect(samplePets([], PAGE_SIZE, 1)).toEqual([]);
  });
});
