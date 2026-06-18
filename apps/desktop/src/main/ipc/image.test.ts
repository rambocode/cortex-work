// image:save / image:read 的纯函数单测(接收 root 入参 → 临时目录跑真实 fs,
// 无需 electron app/paths)。重点:magic-bytes 嗅探、体积上限、symlink 逃逸防护、根边界。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// image.ts 顶层 import electron(ipcMain)与 ../paths(electron app)→ 必须 mock。
vi.mock("electron", () => ({
  ipcMain: { handle: () => {} },
  app: { getPath: () => "/tmp", isPackaged: false, getAppPath: () => "/app" },
}));

import { isInsideRoot, MAX_IMAGE_BYTES, readImageFrom, saveImageInto, sniffImageExt } from "./image";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), Buffer.from([0, 0])]);
const SVG = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>");

// 复制成独立 ArrayBuffer(模拟 renderer 经 IPC 传来的 data)。
const ab = (b: Buffer): ArrayBuffer => new Uint8Array(b).buffer;

let base: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "img-ipc-"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("sniffImageExt", () => {
  it("真实头 → 对应 ext", () => {
    expect(sniffImageExt(PNG)).toBe("png");
    expect(sniffImageExt(JPEG)).toBe("jpg");
    expect(sniffImageExt(GIF)).toBe("gif");
    expect(sniffImageExt(WEBP)).toBe("webp");
  });
  it("SVG / 截断字节 → null", () => {
    expect(sniffImageExt(SVG)).toBeNull();
    expect(sniffImageExt(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe("isInsideRoot", () => {
  it("根内 true;越界 / 同名前缀 false", () => {
    expect(isInsideRoot(base, join(base, "a", "b.png"))).toBe(true);
    expect(isInsideRoot(base, base)).toBe(true);
    expect(isInsideRoot(base, "/etc/passwd")).toBe(false);
    expect(isInsideRoot(base, `${base}-sibling/x.png`)).toBe(false);
  });
});

describe("saveImageInto", () => {
  it("正常 PNG → 落盘,文件名为 uuid.png", async () => {
    const { path } = await saveImageInto(base, "sess1", "image/png", ab(PNG));
    expect(existsSync(path)).toBe(true);
    expect(path).toMatch(/[/\\]sess1[/\\][0-9a-f-]+\.png$/);
  });
  it("声明 png 但字节是 svg → 拒绝、不写", async () => {
    await expect(saveImageInto(base, "sess1", "image/png", ab(SVG))).rejects.toThrow();
  });
  it("声明 MIME 与真实字节不符(gif vs png) → 拒绝", async () => {
    await expect(saveImageInto(base, "sess1", "image/gif", ab(PNG))).rejects.toThrow(/不符/);
  });
  it("超体积上限 → 拒绝", async () => {
    await expect(saveImageInto(base, "sess1", "image/png", new ArrayBuffer(MAX_IMAGE_BYTES + 1))).rejects.toThrow(
      /过大/,
    );
  });
  it("非法 sessionId(路径穿越) → 拒绝", async () => {
    await expect(saveImageInto(base, "../evil", "image/png", ab(PNG))).rejects.toThrow(/session id/);
  });
});

describe("readImageFrom", () => {
  it("刚落盘的图 → 正确 data: 前缀", async () => {
    const { path } = await saveImageInto(base, "sessR", "image/png", ab(PNG));
    const r = await readImageFrom(base, path);
    expect(r.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });
  it("根外路径 → 拒绝", async () => {
    await expect(readImageFrom(base, "/etc/passwd")).rejects.toThrow(/允许范围/);
  });
  it("符号链接(指向根外) → 拒绝(symlink 逃逸防护)", async () => {
    const { path } = await saveImageInto(base, "sessL", "image/png", ab(PNG));
    const link = `${path}.link.png`;
    symlinkSync("/etc/passwd", link);
    await expect(readImageFrom(base, link)).rejects.toThrow(/允许范围/);
  });
  it("文件不存在 → reject(ENOENT 可识别)", async () => {
    await expect(readImageFrom(base, join(base, "sessR", "nope.png"))).rejects.toThrow();
  });
});
