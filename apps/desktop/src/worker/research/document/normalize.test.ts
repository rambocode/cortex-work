// normalize 单测：正文归一 + SHA-256 内容指纹。
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { normalizeExtractedText } from "@cortex-work/core/research/chunking";
import { normalizeDocument, sha256Hex } from "./normalize";

describe("sha256Hex", () => {
  it("与 node:crypto 逐字一致（内容哈希是跨 Session 复用主键，不能自创算法）", () => {
    const text = "Cortex Research Engine";
    expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });

  it("空串也有确定哈希", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("normalizeDocument", () => {
  it("正文走 core 的 normalizeExtractedText，哈希基于归一后的文本", () => {
    const raw = "  第一段\r\n\r\n\r\n第二段   有   多余空白  ";
    const result = normalizeDocument(raw);
    expect(result.text).toBe(normalizeExtractedText(raw));
    expect(result.contentHash).toBe(sha256Hex(result.text));
    expect(result.textLength).toBe(result.text.length);
  });

  it("仅空白差异的两份正文得到同一个 contentHash（去重的基础）", () => {
    const a = normalizeDocument("Hello   world\r\n\r\n\r\n\r\nagain");
    const b = normalizeDocument("Hello world\n\nagain");
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("simhash 与 contentHash 同时产出，且 simhash 是 16 位十六进制", () => {
    const result = normalizeDocument("Cortex Desktop 是一个团队 Agent 应用。");
    expect(result.simhash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
