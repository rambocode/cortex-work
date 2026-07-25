// simhash 单测：64 位指纹 + 汉明距离 + 近重复聚簇。表驱动，纯函数。
import { describe, expect, it } from "vitest";
import { clusterByHamming, hammingDistance, simhashHex } from "./simhash";

const BASE =
  "Cortex Desktop is an open source team agent application. It ships an Electron shell " +
  "and a shared core package used by both web and desktop clients.";
// 只改了一个词：近重复，汉明距离应当很小。
const NEAR =
  "Cortex Desktop is an open source team agent application. It ships an Electron shell " +
  "and a shared core module used by both web and desktop clients.";
const FAR =
  "红烧肉的做法：五花肉切块焯水，冰糖炒糖色，加入生抽老抽与八角桂皮，小火慢炖四十分钟收汁。";

describe("simhashHex", () => {
  it("输出恒为 16 位十六进制（64 bit）", () => {
    for (const text of [BASE, NEAR, FAR, "", "a"]) {
      expect(simhashHex(text)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("同一文本恒定（可作为跨 Session 的稳定指纹）", () => {
    expect(simhashHex(BASE)).toBe(simhashHex(BASE));
  });

  it("空白差异不改变指纹（词法分词已归一）", () => {
    expect(simhashHex(BASE)).toBe(simhashHex(`  ${BASE.replace(/ /g, "  ")}  `));
  });
});

describe("hammingDistance", () => {
  it("近重复文本距离小，无关文本距离大", () => {
    const near = hammingDistance(simhashHex(BASE), simhashHex(NEAR));
    const far = hammingDistance(simhashHex(BASE), simhashHex(FAR));
    expect(near).toBeLessThanOrEqual(6);
    expect(far).toBeGreaterThan(near);
  });

  it("自身距离为 0", () => {
    expect(hammingDistance(simhashHex(BASE), simhashHex(BASE))).toBe(0);
  });

  it("非法十六进制返回 64（最大距离），不抛错", () => {
    expect(hammingDistance("zzzz", "0000000000000000")).toBe(64);
  });
});

describe("clusterByHamming", () => {
  it("把近重复归入同一簇，代表取首个成员", () => {
    const clusters = clusterByHamming(
      [
        { id: "a", hash: simhashHex(BASE) },
        { id: "b", hash: simhashHex(NEAR) },
        { id: "c", hash: simhashHex(FAR) },
      ],
      6,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ representativeId: "a", memberIds: ["b"] });
  });

  it("没有近重复时不产出任何簇", () => {
    const clusters = clusterByHamming(
      [
        { id: "a", hash: simhashHex(BASE) },
        { id: "c", hash: simhashHex(FAR) },
      ],
      3,
    );
    expect(clusters).toEqual([]);
  });

  it("传播性：a~b、b~c 时三者同簇（贪心串联）", () => {
    const clusters = clusterByHamming(
      [
        { id: "a", hash: "0000000000000000" },
        { id: "b", hash: "0000000000000001" },
        { id: "c", hash: "0000000000000003" },
      ],
      2,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.memberIds).toEqual(["b", "c"]);
  });
});
