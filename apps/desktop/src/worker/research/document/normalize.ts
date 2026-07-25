// 正文归一 + 内容指纹（spec §12.4 的 normalized text → SHA-256 → SimHash 环节）。
//
// 归一必须**先于**切块与哈希发生：切块产出的 offset 语义是「相对归一后的正文」，
// 落库正文也必须是归一后的那一份，否则引用回溯会整体错位（见 core/research/chunking 头部注释）。
// 因此本模块是抓取管线里唯一允许改写正文字符的地方。
//
// 本文件跑在 utilityProcess Worker 里，禁止 import electron。
import { createHash } from "node:crypto";
import { normalizeExtractedText } from "@cortex-work/core/research/chunking";
import { simhashHex } from "../dedup/simhash";

/// SHA-256 十六进制摘要。**必须用 node:crypto 而不是自造实现**：contentHash 是跨 Session
/// 复用与去重的主键，一旦算法漂移，历史指纹全部作废且不会有任何报错。
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/// 归一化后的文档正文与其指纹。
export interface NormalizedDocument {
  text: string;
  textLength: number;
  contentHash: string;
  simhash: string;
}

/// 一次性完成：归一 → SHA-256（精确去重）→ SimHash（近似去重）。
/// 两个指纹都基于**归一后**的文本：否则「只差空白」的两份转载会得到不同的 contentHash。
export function normalizeDocument(raw: string): NormalizedDocument {
  const text = normalizeExtractedText(raw);
  return {
    text,
    textLength: text.length,
    contentHash: sha256Hex(text),
    simhash: simhashHex(text),
  };
}
