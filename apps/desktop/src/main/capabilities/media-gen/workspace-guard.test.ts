// workspace-guard.test.ts — assertRealWithinWorkspace / collectReferenceImages 的
// symlink 逃逸用例（真实文件系统，tmpdir 实测；client.test.ts 全局 mock 了 fs 无法覆盖）。
//
// 威胁模型：Agent 可控 workspace 内容——在 workspace 内造一个指向外部（~/.ssh 等）的
// symlink，lexical 校验会放行；读侧会把外部文件读进 dataUri 外发，写侧会把产物写出
// workspace。本文件断言 realpath 复核把这两条路都堵死。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRealWithinWorkspace,
  collectFrameImage,
  collectReferenceImages,
} from "./client";

// 最小合法 PNG 头（魔数 8 字节 + 填充），足以通过 detectImageMime。
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);

let workspace: string;
let outside: string;

beforeEach(async () => {
  // workspace 与 outside 互为兄弟目录，均在系统 tmpdir 下。
  const base = await mkdtemp(join(tmpdir(), "media-guard-"));
  workspace = join(base, "workspace");
  outside = join(base, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(join(workspace, ".."), { recursive: true, force: true });
});

describe("assertRealWithinWorkspace — 读侧 symlink 逃逸", () => {
  it("workspace 内正常文件通过并返回展开后的绝对路径", async () => {
    await writeFile(join(workspace, "ok.png"), PNG_BYTES);
    const resolved = await assertRealWithinWorkspace(workspace, "ok.png");
    // macOS 的 /tmp 是 /private/tmp 的 symlink，展开后路径可能带 /private 前缀，
    // 断言用后缀匹配而非全等。
    expect(resolved.endsWith("/workspace/ok.png")).toBe(true);
  });

  it("workspace 内指向外部文件的 symlink 被拒", async () => {
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "TOP SECRET");
    await symlink(secret, join(workspace, "innocent.png"));
    await expect(assertRealWithinWorkspace(workspace, "innocent.png")).rejects.toThrow(/路径越界/);
  });

  it("workspace 内指向外部目录的 symlink 目录被拒（经由目录穿出）", async () => {
    await symlink(outside, join(workspace, "linkdir"));
    await writeFile(join(outside, "file.bin"), "data");
    await expect(assertRealWithinWorkspace(workspace, "linkdir/file.bin")).rejects.toThrow(/路径越界/);
  });

  it("写侧：目标文件不存在但父目录是外部 symlink → 被拒（最近存在祖先复核）", async () => {
    // 模拟 .cortex/media/images 目录被替换成指向外部的 symlink 的竞态终态。
    await mkdir(join(workspace, ".cortex", "media"), { recursive: true });
    await symlink(outside, join(workspace, ".cortex", "media", "images"));
    await expect(
      assertRealWithinWorkspace(workspace, ".cortex/media/images/new-file.png"),
    ).rejects.toThrow(/路径越界/);
  });

  it("写侧：目标文件不存在且祖先均为真实目录 → 通过", async () => {
    await mkdir(join(workspace, ".cortex", "media", "images"), { recursive: true });
    const resolved = await assertRealWithinWorkspace(workspace, ".cortex/media/images/new-file.png");
    expect(resolved.endsWith("/workspace/.cortex/media/images/new-file.png")).toBe(true);
  });

  it("lexical 越界（../）仍在第一道被拒", async () => {
    await expect(assertRealWithinWorkspace(workspace, "../outside/secret.txt")).rejects.toThrow(/路径越界/);
  });
});

describe("collectReferenceImages / collectFrameImage — 读取管线", () => {
  it("合法 png 参考图收集为 dataUri", async () => {
    await writeFile(join(workspace, "ref.png"), PNG_BYTES);
    const images = await collectReferenceImages(workspace, ["ref.png"]);
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe("image/png");
    expect(images[0].dataUri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("symlink 指向外部图片 → 拒绝（不读取外发）", async () => {
    await writeFile(join(outside, "leak.png"), PNG_BYTES);
    await symlink(join(outside, "leak.png"), join(workspace, "ref.png"));
    await expect(collectReferenceImages(workspace, ["ref.png"])).rejects.toThrow(/路径越界/);
  });

  it("非图片内容（魔数不符）→ 拒绝", async () => {
    await writeFile(join(workspace, "fake.png"), Buffer.from("not an image"));
    await expect(collectReferenceImages(workspace, ["fake.png"])).rejects.toThrow(/png\/jpeg\/webp/);
  });

  it("数量超上限 → 拒绝", async () => {
    const paths = ["a.png", "b.png", "c.png", "d.png", "e.png"];
    await expect(collectReferenceImages(workspace, paths, 4)).rejects.toThrow(/最多 4 张/);
  });

  it("空列表 / undefined → 空数组", async () => {
    expect(await collectReferenceImages(workspace, undefined)).toEqual([]);
    expect(await collectReferenceImages(workspace, [])).toEqual([]);
  });

  it("collectFrameImage：空路径 → undefined；symlink 逃逸 → 拒绝", async () => {
    expect(await collectFrameImage(workspace, undefined, "first_frame")).toBeUndefined();
    expect(await collectFrameImage(workspace, "  ", "first_frame")).toBeUndefined();

    await writeFile(join(outside, "frame.png"), PNG_BYTES);
    await symlink(join(outside, "frame.png"), join(workspace, "frame.png"));
    await expect(collectFrameImage(workspace, "frame.png", "first_frame")).rejects.toThrow(/路径越界/);
  });
});
