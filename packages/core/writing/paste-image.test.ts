// 粘贴图片(U1)渲染端纯逻辑单测:剪贴板图片提取、mime→扩展名、相对链接换算。
import { describe, expect, it } from "vitest";
import {
  clipboardHasImageFile,
  extractClipboardImageFile,
  imageExtFromMime,
  relativeImageLink,
  type ClipboardImageItemLike,
} from "./paste-image";

// 构造剪贴板 item 桩(kind/type + getAsFile 返回给定 File 或 null)。
function item(kind: string, type: string, file: File | null): ClipboardImageItemLike {
  return { kind, type, getAsFile: () => file };
}

function pngFile(name = "x.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

describe("extractClipboardImageFile", () => {
  it("提取首个图片文件,携带其 mime", () => {
    const png = pngFile();
    const items = [item("string", "text/plain", null), item("file", "image/png", png)];
    expect(extractClipboardImageFile(items)).toEqual({ file: png, mime: "image/png" });
  });

  it("多图片时取第一个", () => {
    const a = pngFile("a.png");
    const b = pngFile("b.png");
    const items = [item("file", "image/png", a), item("file", "image/jpeg", b)];
    expect(extractClipboardImageFile(items)?.file).toBe(a);
  });

  it("非图片粘贴(纯文本)返回 null → 调用方放行默认粘贴", () => {
    const items = [item("string", "text/plain", null)];
    expect(extractClipboardImageFile(items)).toBeNull();
  });

  it("kind 非 file(如 string 图片)不算,返回 null", () => {
    const items = [item("string", "image/png", null)];
    expect(extractClipboardImageFile(items)).toBeNull();
  });

  it("getAsFile 返回 null 时跳过该项", () => {
    const items = [item("file", "image/png", null)];
    expect(extractClipboardImageFile(items)).toBeNull();
  });

  it("空/未定义 items 返回 null", () => {
    expect(extractClipboardImageFile(null)).toBeNull();
    expect(extractClipboardImageFile(undefined)).toBeNull();
    expect(extractClipboardImageFile([])).toBeNull();
  });
});

describe("clipboardHasImageFile", () => {
  it("含图片文件 → true", () => {
    expect(clipboardHasImageFile([item("file", "image/webp", pngFile())])).toBe(true);
  });
  it("无图片 → false", () => {
    expect(clipboardHasImageFile([item("string", "text/plain", null)])).toBe(false);
    expect(clipboardHasImageFile(null)).toBe(false);
  });
});

describe("imageExtFromMime", () => {
  it("常见 mime 映射(jpeg→jpg)", () => {
    expect(imageExtFromMime("image/png")).toBe("png");
    expect(imageExtFromMime("image/jpeg")).toBe("jpg");
    expect(imageExtFromMime("image/gif")).toBe("gif");
    expect(imageExtFromMime("image/webp")).toBe("webp");
    expect(imageExtFromMime("image/svg+xml")).toBe("svg");
    expect(imageExtFromMime("IMAGE/PNG")).toBe("png"); // 大小写不敏感
  });
  it("未映射但形如 image/<subtype> → 取 subtype(去 +xml)", () => {
    expect(imageExtFromMime("image/apng")).toBe("apng");
  });
  it("无法识别 → 回落 png", () => {
    expect(imageExtFromMime("")).toBe("png");
    expect(imageExtFromMime("application/octet-stream")).toBe("png");
    expect(imageExtFromMime("image/x_weird!type")).toBe("png");
  });
});

describe("relativeImageLink", () => {
  it("同目录:md 与图片同级 → 裸文件名", () => {
    expect(relativeImageLink("/root/a/note.md", "/root/a/pic.png")).toBe("pic.png");
  });
  it("子目录:图片在 md 目录下的 img/ → img/pic.png", () => {
    expect(relativeImageLink("/root/a/note.md", "/root/a/img/pic.png")).toBe("img/pic.png");
  });
  it("父目录方向:md 更深,图片在上层 img/ → ../img/pic.png(../ 折叠正确)", () => {
    expect(relativeImageLink("/root/a/sub/note.md", "/root/a/img/pic.png")).toBe("../img/pic.png");
  });
  it("多层向上:两级深 → ../../img/pic.png", () => {
    expect(relativeImageLink("/root/a/b/c/note.md", "/root/a/img/pic.png")).toBe("../../img/pic.png");
  });
  it("Windows 反斜杠归一化后同样正确", () => {
    expect(relativeImageLink("C:\\ws\\a\\note.md", "C:\\ws\\a\\img\\pic.png")).toBe("img/pic.png");
  });
});
