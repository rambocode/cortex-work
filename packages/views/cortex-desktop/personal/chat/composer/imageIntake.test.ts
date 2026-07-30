// imageIntake 纯函数单测:格式/大小校验、原因文案、去重键(无 DOM 依赖)。
import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  checkImageFile,
  imageDedupeKey,
  isAcceptedImage,
  rejectReasonText,
} from "./imageIntake";

describe("imageIntake 纯函数", () => {
  it("isAcceptedImage:PNG/JPEG/GIF/WebP 通过;SVG/文本拒", () => {
    expect(isAcceptedImage("image/png")).toBe(true);
    expect(isAcceptedImage("image/jpeg")).toBe(true);
    expect(isAcceptedImage("image/gif")).toBe(true);
    expect(isAcceptedImage("image/webp")).toBe(true);
    expect(isAcceptedImage("image/svg+xml")).toBe(false);
    expect(isAcceptedImage("text/plain")).toBe(false);
  });

  it("checkImageFile:格式 → type;超大 → size;正常 → null", () => {
    expect(checkImageFile({ type: "image/svg+xml", size: 10 })).toBe("type");
    expect(checkImageFile({ type: "image/png", size: MAX_IMAGE_BYTES + 1 })).toBe("size");
    expect(checkImageFile({ type: "image/png", size: 1000 })).toBeNull();
  });

  it("rejectReasonText:含文件名与原因", () => {
    expect(rejectReasonText("type", "a.svg")).toContain("a.svg");
    expect(rejectReasonText("type", "a.svg")).toContain("PNG/JPEG/GIF/WebP");
    expect(rejectReasonText("size", "big.png")).toContain("big.png");
  });

  it("imageDedupeKey:name+size 唯一", () => {
    expect(imageDedupeKey("a.png", 100)).toBe("a.png:100");
    expect(imageDedupeKey("a.png", 100)).toBe(imageDedupeKey("a.png", 100));
    expect(imageDedupeKey("a.png", 100)).not.toBe(imageDedupeKey("a.png", 200));
    expect(imageDedupeKey("a.png", 100)).not.toBe(imageDedupeKey("b.png", 100));
  });
});
