// 写作检索 IPC 域单测(U4):内存索引 + 缓存失效重建 + 空间无文档降级。
// 用真实临时目录跑真实 fs;electron 仅需 ipcMain 存根(handler 注册不在本测范围)。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 模块顶层 import electron:存根 ipcMain,使 import 不炸(本测直接调导出的纯业务函数)。
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import {
  clearWritingRetrievalCache,
  writingRetrieve,
  writingRetrievalInvalidate,
} from "./writing-retrieval";

let ws = "";

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), "writing-retrieval-"));
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

beforeEach(() => {
  clearWritingRetrievalCache(); // 隔离用例间的内存索引
});

describe("writingRetrieve", () => {
  it("空间无文档 → 返回 null(渲染端静默不注入)", async () => {
    const empty = await mkdtemp(join(tmpdir(), "writing-retrieval-empty-"));
    try {
      const ctx = await writingRetrieve({ root: empty, query: "photosynthesis", k: 3 });
      expect(ctx).toBeNull();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("空 root / 空查询 → 返回 null", async () => {
    expect(await writingRetrieve({ root: "", query: "x", k: 3 })).toBeNull();
    expect(await writingRetrieve({ root: ws, query: "   ", k: 3 })).toBeNull();
  });

  it("命中文档 → 返回带片段的上下文", async () => {
    await writeFile(
      join(ws, "topic.md"),
      "# Photosynthesis\n\nPhotosynthesis lets green plants turn sunlight into energy via chlorophyll.\n",
      "utf8",
    );
    const ctx = await writingRetrieve({ root: ws, query: "photosynthesis chlorophyll", k: 3 });
    expect(ctx).not.toBeNull();
    expect(ctx!.snippets.length).toBeGreaterThan(0);
    expect(ctx!.snippets[0].path).toBe("topic.md");
  });

  it("索引失效重建:文件改动后 invalidate → 检索到新内容", async () => {
    const file = join(ws, "living.md");
    await writeFile(
      file,
      "# Draft\n\nThe original chapter discusses migratory birds crossing the ocean each winter.\n",
      "utf8",
    );
    // 首次检索建立索引(命中 birds)。
    const first = await writingRetrieve({ root: ws, query: "migratory birds ocean", k: 3 });
    expect(first).not.toBeNull();

    // 改写文件为全新主题;不失效时 TTL 内会命中旧索引,失效后必须读到新内容。
    await writeFile(
      file,
      "# Draft\n\nThe rewritten chapter now explains volcanic eruptions reshaping the coastline.\n",
      "utf8",
    );
    writingRetrievalInvalidate(ws);

    const after = await writingRetrieve({ root: ws, query: "volcanic eruptions coastline", k: 3 });
    expect(after).not.toBeNull();
    expect(after!.snippets.some((s) => s.path === "living.md")).toBe(true);
    // 旧主题不再命中(索引已重建为新内容)。
    const stale = await writingRetrieve({ root: ws, query: "migratory birds ocean", k: 3 });
    expect(stale).toBeNull();
  });
});
