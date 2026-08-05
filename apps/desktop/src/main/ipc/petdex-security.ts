// petdex 图鉴的安全边界。全部是纯函数、**刻意不 import electron / paths**,
// 目录一律由调用方传入——这样可以直接单测,不必起 Electron。
//
// 引入第三方资源(assets.petdex.dev)带来的攻击面全部压在这个文件里:
// 出网目标、落盘路径、以及 protocol handler 能读到哪些文件。

import { sep } from "path";

/** 允许出网的域。只有它和它的子域(assets./cdn. 等)可达。 */
const ALLOWED_HOST = "petdex.dev";

/**
 * 校验资源 URL:必须 https,且 host 是 petdex.dev 或其子域。
 *
 * ⚠️ 不能用 `host.endsWith(".petdex.dev")` 这类字符串判断:
 *   - "evil-petdex.dev" 会被 `endsWith("petdex.dev")` 放过(前面没有点);
 *   - "petdex.dev.evil.com" 会被 `includes` 放过。
 * 故按点切分逐段比对后缀。
 *
 * @throws URL 非法 / 非 https / host 不在白名单
 */
export function assertPetdexAssetUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`petdex: 非法 URL: ${raw}`);
  }
  if (url.protocol !== "https:") throw new Error(`petdex: 仅允许 https,当前 ${url.protocol}`);
  const host = url.hostname.toLowerCase();
  const allowed = host === ALLOWED_HOST || host.endsWith(`.${ALLOWED_HOST}`);
  if (!allowed) throw new Error(`petdex: host 不在白名单: ${url.hostname}`);
  return url;
}

/**
 * slug 白名单化。slug 会直接拼进缓存文件路径,这是路径穿越的唯一防线。
 * @throws 非字符串 / 含路径分隔符或 .. / 不匹配字符集
 */
export function safeSlug(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("petdex: slug 必须是字符串");
  const slug = raw.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) throw new Error(`petdex: 非法 slug: ${raw}`);
  // 字符集已排除 / 与 \,但 ".." 与前导 "." 仍能通过,单独拒绝。
  if (slug.startsWith(".") || slug.includes("..")) throw new Error(`petdex: 非法 slug: ${raw}`);
  return slug;
}

/**
 * 断言路径落在 sprite 缓存目录内。
 * 用于 protocol.handle —— 那条路径不经 IPC 参数校验,是任意文件读取的唯一闸门。
 *
 * ⚠️ 前缀比较必须带上路径分隔符:否则 "/a/petdex-evil" 会被 "/a/petdex" 前缀放过。
 * @throws 越界
 */
export function assertWithinSpritesDir(absPath: string, spritesDir: string): string {
  const root = spritesDir.endsWith(sep) ? spritesDir : spritesDir + sep;
  if (!absPath.startsWith(root)) throw new Error(`petdex: 路径越界: ${absPath}`);
  return absPath;
}

/**
 * 解析 WebP 头部的画布尺寸(VP8 有损 / VP8L 无损 / VP8X 扩展三种 chunk)。
 *
 * **绝不解码像素**(同 ipc/image.ts 的 decompression bomb 原则):我们只需要宽高来推算
 * sprite 网格,为此把一张声称 8000×8000 的图解出来毫无必要且危险。
 *
 * @returns 非 WebP 或头部残缺时返回 null
 */
export function parseWebpSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 30) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("ascii", 12, 16);

  if (chunk === "VP8X") {
    // 扩展格式:24..29 是两个 24-bit 小端的 (宽-1)、(高-1)
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  if (chunk === "VP8 ") {
    // 有损:关键帧起始码 9D 01 2A 之后是两个 16-bit,低 14 位为宽/高
    const i = buf.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
    if (i < 0 || i + 7 > buf.length) return null;
    return { width: buf.readUInt16LE(i + 3) & 0x3fff, height: buf.readUInt16LE(i + 5) & 0x3fff };
  }
  if (chunk === "VP8L") {
    // 无损:21..24 打包了 14 位宽 + 14 位高(均为实际值 - 1)
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}
