import { describe, expect, it } from "vitest";
import { assertPetdexAssetUrl, assertWithinSpritesDir, parseWebpSize, safeSlug } from "./petdex-security";

describe("assertPetdexAssetUrl", () => {
  it.each([
    "https://petdex.dev/manifests/petdex-v1.json",
    "https://assets.petdex.dev/pets/x/sprite.webp",
    "https://cdn.petdex.dev/a.webp",
  ])("放行 %s", (url) => {
    expect(assertPetdexAssetUrl(url).hostname).toContain("petdex.dev");
  });

  // 这两条是「用 endsWith/includes 判断 host」会直接放过的经典绕过,必须拒。
  it.each([
    ["前缀伪装", "https://evil-petdex.dev/a.webp"],
    ["后缀伪装", "https://petdex.dev.evil.com/a.webp"],
    ["路径伪装", "https://evil.com/petdex.dev/a.webp"],
    ["非 https", "http://assets.petdex.dev/a.webp"],
    ["file 协议", "file:///etc/passwd"],
    ["非法 URL", "not a url"],
  ])("拒绝 %s", (_name, url) => {
    expect(() => assertPetdexAssetUrl(url)).toThrow();
  });
});

describe("safeSlug", () => {
  it.each(["homelander", "mecha-xiaobai", "zero-two-2", "a.b_c-d"])("放行 %s", (s) => {
    expect(safeSlug(s)).toBe(s);
  });

  it.each([
    ["路径穿越", "../../etc/passwd"],
    ["含斜杠", "a/b"],
    ["含反斜杠", "a\\b"],
    ["双点", "a..b"],
    ["前导点", ".hidden"],
    ["空串", ""],
    ["超长", "a".repeat(65)],
    ["非字符串", 42],
    ["null", null],
  ])("拒绝 %s", (_name, s) => {
    expect(() => safeSlug(s)).toThrow();
  });
});

describe("assertWithinSpritesDir", () => {
  const dir = "/home/u/.cortex-desktop/petdex/sprites";

  it("放行目录内文件", () => {
    expect(assertWithinSpritesDir(`${dir}/cat.webp`, dir)).toBe(`${dir}/cat.webp`);
  });

  // 不带分隔符做前缀比较时,这个兄弟目录会被放过。
  it("拒绝同前缀的兄弟目录", () => {
    expect(() => assertWithinSpritesDir("/home/u/.cortex-desktop/petdex/sprites-evil/x.webp", dir)).toThrow();
  });

  it("拒绝目录外路径", () => {
    expect(() => assertWithinSpritesDir("/etc/passwd", dir)).toThrow();
  });
});

describe("parseWebpSize", () => {
  // 构造最小合法头:RIFF....WEBPVP8X + 两个 24-bit 小端(宽-1、高-1)
  function vp8x(width: number, height: number): Buffer {
    const b = Buffer.alloc(32);
    b.write("RIFF", 0, "ascii");
    b.write("WEBP", 8, "ascii");
    b.write("VP8X", 12, "ascii");
    b.writeUIntLE(width - 1, 24, 3);
    b.writeUIntLE(height - 1, 27, 3);
    return b;
  }

  // VP8L 是 petdex 实际在用的格式(抽样 10 张全部是 VP8L);VP8X 是本仓自有 cat 资产的格式。
  // 两条分支都必须覆盖——只测 VP8X 会让「petdex 图全部读不出尺寸」这种错误溜过去。
  function vp8l(width: number, height: number): Buffer {
    const b = Buffer.alloc(32);
    b.write("RIFF", 0, "ascii");
    b.write("WEBP", 8, "ascii");
    b.write("VP8L", 12, "ascii");
    b.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
    return b;
  }

  it.each([
    ["VP8L 1536×1872(petdex 主流)", vp8l(1536, 1872), { width: 1536, height: 1872 }],
    ["VP8L 1536×2288(11 行变体)", vp8l(1536, 2288), { width: 1536, height: 2288 }],
    ["VP8L 1728×1664(9 列变体)", vp8l(1728, 1664), { width: 1728, height: 1664 }],
    ["VP8X 880×200(本仓自有 cat 资产)", vp8x(880, 200), { width: 880, height: 200 }],
  ])("解析 %s", (_name, buf, expected) => {
    expect(parseWebpSize(buf)).toEqual(expected);
  });

  it.each([
    ["太短", Buffer.alloc(8)],
    ["非 RIFF", Buffer.alloc(40)],
    ["RIFF 但非 WEBP", (() => { const b = Buffer.alloc(40); b.write("RIFF", 0, "ascii"); b.write("AVI ", 8, "ascii"); return b; })()],
    ["未知 chunk", (() => { const b = Buffer.alloc(40); b.write("RIFF", 0, "ascii"); b.write("WEBP", 8, "ascii"); b.write("XXXX", 12, "ascii"); return b; })()],
  ])("%s → null", (_name, buf) => {
    expect(parseWebpSize(buf)).toBeNull();
  });
});
