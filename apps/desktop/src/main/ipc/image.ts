// 聊天图片上传:落盘(image:save) + 缩略图回读(image:read)。
// 统一「落盘拿绝对路径」骨架,各 agent 走原生通道(claude 路径进 prompt、codex -i、pi RPC images)。
//
// 安全要点:
//  - 写侧权威闸门:magic-bytes 嗅探真实类型(不信任声明 MIME/原始名)+ randomUUID 文件名
//    + byteLength 上限 + 目录 0700;绝不解码图片(防 decompression bomb)。
//  - 读侧唯一闸门:image:read 绕过项目白名单 assertAllowed,故 chat-images 根白名单是任意
//    文件读取的唯一防线 —— realpath 解析 + lstat 拒符号链接 + 严格根边界,且读「校验后的真实
//    路径」而非原始入参,消除 check→use 之间被换成 symlink 的 TOCTOU。
//  - 核心 fs 逻辑抽成接收 root 入参的纯函数(saveImageInto / readImageFrom),不依赖 electron
//    app/paths → 可用临时目录单测(见 image.test.ts)。

import { ipcMain } from "electron";
import { promises as fsp } from "fs";
import { randomUUID } from "crypto";
import { extname, join, resolve, sep } from "path";
import { chatImagesRoot } from "../paths";
import { enqueue } from "./sessionWriteQueue";
import type { ImageReadResult, ImageSaveRequest, ImageSaveResult } from "./types";

// 主进程是权威闸门(renderer imageIntake.ts 的 MAX_IMAGE_BYTES 仅 UX 预检,须与此值一致)。
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

const SAFE_ID = /^[\w-]+$/;

type ImageExt = "png" | "jpg" | "gif" | "webp";

const EXT_MIME: Record<ImageExt, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

// magic-bytes 嗅探真实图片类型;扩展名由嗅探结果决定,杜绝「svg 改名 png」与扩展名⁄字节错配。
export function sniffImageExt(buf: Buffer): ImageExt | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "gif";
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 && // "RIFF"
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50 // "WEBP"
  )
    return "webp";
  return null;
}

// 声明 MIME 是否与嗅探出的扩展名一致(jpg 容忍 image/jpeg 与 image/jpg)。
function mimeMatchesExt(mimeType: string, ext: ImageExt): boolean {
  const m = mimeType.toLowerCase();
  if (ext === "jpg") return m === "image/jpeg" || m === "image/jpg";
  return m === EXT_MIME[ext];
}

function extToImageExt(ext: string): ImageExt | null {
  const e = ext.replace(/^\./, "").toLowerCase();
  if (e === "png") return "png";
  if (e === "jpg" || e === "jpeg") return "jpg";
  if (e === "gif") return "gif";
  if (e === "webp") return "webp";
  return null;
}

// 严格分隔符边界匹配(输入应为已 realpath 的绝对路径)。导出供单测。
export function isInsideRoot(root: string, abs: string): boolean {
  const p = resolve(root);
  const c = resolve(abs);
  return c === p || c.startsWith(p + sep);
}

// 落盘:写侧权威校验。root = chat-images 根,沿 sessionId 建子目录,返回绝对路径。
export async function saveImageInto(
  root: string,
  sessionId: string,
  mimeType: string,
  data: ArrayBuffer,
): Promise<ImageSaveResult> {
  if (!SAFE_ID.test(sessionId)) throw new Error(`非法 session id: ${sessionId}`);
  if (data.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大: ${data.byteLength} 字节 > 上限 ${MAX_IMAGE_BYTES}`);
  }
  const buf = Buffer.from(data);
  const ext = sniffImageExt(buf);
  if (!ext) throw new Error("不支持的图片格式(仅 PNG/JPEG/GIF/WebP;magic-bytes 嗅探未命中)");
  if (!mimeMatchesExt(mimeType, ext)) throw new Error(`图片 MIME 与真实字节不符: ${mimeType} ≠ ${ext}`);
  const dir = join(root, sessionId);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${randomUUID()}.${ext}`);
  const tmp = `${path}.tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, path);
  return { path };
}

// 读侧唯一闸门(返回 base64 + mime)。realpath + lstat 拒符号链接 + 根边界 + 扩展名 allowlist;
// 读校验后的真实路径(非原始入参)消除 TOCTOU;只 base64 搬运,绝不解码。
// 缩略图(image:read → dataUrl)与 pi RPC images(base64 注入)共用此闸门。
export async function readImageBytes(root: string, requested: string): Promise<{ mimeType: string; base64: string }> {
  let realRoot: string;
  try {
    realRoot = await fsp.realpath(root); // 根不存在 = 无任何图片可读
  } catch {
    throw new Error(`路径不在允许范围内: ${requested}`);
  }
  let st;
  try {
    st = await fsp.lstat(requested);
  } catch {
    const e = new Error(`图片不存在: ${requested}`) as NodeJS.ErrnoException;
    e.code = "ENOENT";
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error(`路径不在允许范围内: ${requested}`); // 我们落盘的都是普通文件
  const realTarget = await fsp.realpath(requested);
  if (!isInsideRoot(realRoot, realTarget)) throw new Error(`路径不在允许范围内: ${requested}`);
  const ext = extToImageExt(extname(realTarget));
  if (!ext) throw new Error(`不支持的图片扩展名: ${requested}`); // 读侧也只放行位图,绝不返回 svg
  const buf = await fsp.readFile(realTarget); // 读已校验的真实路径,消除 TOCTOU
  return { mimeType: EXT_MIME[ext], base64: buf.toString("base64") };
}

// 缩略图回读:包装成 data: URL。
export async function readImageFrom(root: string, requested: string): Promise<ImageReadResult> {
  const { mimeType, base64 } = await readImageBytes(root, requested);
  return { dataUrl: `data:${mimeType};base64,${base64}` };
}

export function registerImageHandlers(): void {
  // 落盘经共享 sessionWriteQueue,与同会话的 chat:save/chat:delete 串行,避免删除时留孤儿。
  ipcMain.handle("image:save", (_e, req: ImageSaveRequest): Promise<ImageSaveResult> =>
    enqueue(req.sessionId, () => saveImageInto(chatImagesRoot(), req.sessionId, req.mimeType, req.data)),
  );

  ipcMain.handle("image:read", (_e, path: string): Promise<ImageReadResult> =>
    readImageFrom(chatImagesRoot(), path),
  );
}
