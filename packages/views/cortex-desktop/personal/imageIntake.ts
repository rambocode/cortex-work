// 聊天图片采集纯函数:格式/大小校验 + File → PendingImage(dataUrl 预览 + ArrayBuffer 落盘
// + 尽力取宽高)。校验逻辑是纯函数便于单测;读取用 FileReader/Image(jsdom 可跑,宽高取不到则
// 留空)。上限常量与主进程 image.ts 的 MAX_IMAGE_BYTES 同值(主进程是权威闸门,这里仅 UX 预检)。

import type { PendingImage } from "@cortex-work/core";

export const ACCEPTED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
export const MAX_IMAGES_PER_MESSAGE = 6;

export function isAcceptedImage(mimeType: string): boolean {
  return ACCEPTED_IMAGE_MIMES.includes(mimeType);
}

export type ImageRejectReason = "type" | "size";

// 纯校验(不读内容):格式不支持 / 超大 → 返回原因;通过 → null。
export function checkImageFile(file: { type: string; size: number }): ImageRejectReason | null {
  if (!isAcceptedImage(file.type)) return "type";
  if (file.size > MAX_IMAGE_BYTES) return "size";
  return null;
}

export function rejectReasonText(reason: ImageRejectReason, name: string): string {
  return reason === "type"
    ? `不支持的图片格式：${name || "图片"}（仅 PNG/JPEG/GIF/WebP）`
    : `图片过大：${name || "图片"}（上限 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB）`;
}

// 同批 + 与已有去重的键:name + 字节数(剪贴板截图常同名,但内容多不同;同名同尺寸视为重复)。
export function imageDedupeKey(name: string, size: number): string {
  return `${name}:${size}`;
}

let intakeSeq = 0;

// File → PendingImage。调用方应先 checkImageFile(此处只读取)。用 FileReader 读 ArrayBuffer
// 与 dataUrl(jsdom 均支持;不依赖 File.arrayBuffer)。width/height 暂不采集(渲染用固定尺寸
// object-fit:cover,无消费方;需要时再补,避免 jsdom 里 Image 不触发 load 导致采集挂起)。
export async function fileToPendingImage(file: File): Promise<PendingImage> {
  const data = await readAs(file, "arrayBuffer");
  const dataUrl = await readAs(file, "dataUrl");
  intakeSeq += 1;
  return {
    id: `img-${intakeSeq}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || "image",
    mimeType: file.type,
    dataUrl: dataUrl as string,
    data: data as ArrayBuffer,
  };
}

function readAs(file: Blob, as: "arrayBuffer" | "dataUrl"): Promise<ArrayBuffer | string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result ?? (as === "dataUrl" ? "" : new ArrayBuffer(0)));
    r.onerror = () => reject(r.error ?? new Error("读取图片失败"));
    if (as === "dataUrl") r.readAsDataURL(file);
    else r.readAsArrayBuffer(file);
  });
}
