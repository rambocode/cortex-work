// 任务附件落盘/删除纯函数单测（U13）：接收 root/dir 入参 → 临时目录跑真实 fs。
// 复用聊天文档闸门（doc.ts），重点验证：文档类型成功落盘 + 引用形状、非白名单/超限被拒、
// delete 走 assertDocPath 边界（越界/符号链接拒绝、文件不存在报 ENOENT）。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// task-doc.ts → doc.ts 顶层 import electron(ipcMain)与 ../paths(electron app)→ 必须 mock。
vi.mock("electron", () => ({
  ipcMain: { handle: () => {} },
  app: { getPath: () => "/tmp", isPackaged: false, getAppPath: () => "/app" },
}));

import { saveTaskDoc, deleteTaskDoc } from "./task-doc";
import { MAX_DOC_BYTES } from "./doc";

const PDF = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.from("-1.7\n%abc")]); // %PDF-1.7
const TXT = Buffer.from("hello, 任务附件\n");
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(8)]); // PK zip 头
const ab = (b: Buffer): ArrayBuffer => new Uint8Array(b).buffer;

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "task-doc-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("saveTaskDoc", () => {
  it("文档类型成功落盘并返回引用（path/name/mimeType/sizeBytes）", async () => {
    const ref = await saveTaskDoc(root, "task-a", {
      name: "计划.pdf",
      mimeType: "application/pdf",
      data: ab(PDF),
    });
    expect(existsSync(ref.path)).toBe(true);
    expect(ref.path).toMatch(/[/\\]task-a[/\\][0-9a-f-]+\.pdf$/); // uuid 文件名，原始名不入路径
    expect(ref.name).toBe("计划.pdf"); // 原始名仅保留在引用里供显示
    expect(ref.mimeType).toBe("application/pdf");
    expect(ref.sizeBytes).toBe(PDF.byteLength); // 按磁盘真实字节数
  });

  it("非白名单扩展名（旧二进制 .doc）→ 拒绝（图片同理被拒，本期仅文档类型）", async () => {
    await expect(
      saveTaskDoc(root, "task-a", { name: "old.doc", mimeType: "application/msword", data: ab(ZIP) }),
    ).rejects.toThrow(/不支持/);
  });

  it("超体积上限 → 拒绝", async () => {
    await expect(
      saveTaskDoc(root, "task-a", { name: "big.pdf", mimeType: "application/pdf", data: new ArrayBuffer(MAX_DOC_BYTES + 1) }),
    ).rejects.toThrow(/过大/);
  });
});

describe("deleteTaskDoc", () => {
  it("删除刚落盘的附件（边界校验通过 → unlink）", async () => {
    const ref = await saveTaskDoc(root, "task-del", { name: "a.txt", mimeType: "text/plain", data: ab(TXT) });
    expect(existsSync(ref.path)).toBe(true);
    await deleteTaskDoc(join(root, "task-del"), ref.path);
    expect(existsSync(ref.path)).toBe(false);
  });

  it("越界路径（根外）→ 拒绝（防任意文件删除）", async () => {
    await expect(deleteTaskDoc(join(root, "task-del"), "/etc/passwd")).rejects.toThrow(/允许范围/);
  });

  it("符号链接（指向根外）→ 拒绝（symlink 逃逸防护）", async () => {
    const ref = await saveTaskDoc(root, "task-link", { name: "a.pdf", mimeType: "application/pdf", data: ab(PDF) });
    const link = `${ref.path}.link.pdf`;
    symlinkSync("/etc/passwd", link);
    await expect(deleteTaskDoc(join(root, "task-link"), link)).rejects.toThrow(/允许范围/);
  });

  it("文件不存在 → 抛 ENOENT（供 handler 据 code 放行清引用）", async () => {
    await expect(deleteTaskDoc(join(root, "task-del"), join(root, "task-del", "nope.pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
