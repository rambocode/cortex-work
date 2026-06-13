// 编辑器探测单测：纯函数 detectEditors（命中集合 / intellij 多包名 / 顺序）
// 与缓存层 detectCached（TTL 计数 / 非 darwin 空表）。本模块不 import electron，免 mock。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CACHE_TTL_MS, detectCached, detectEditors, resetEditorCache } from "./editors";

const APPS = "/Applications";

// 用一组「已存在路径」集合构造 exists 注入函数。
function existsFrom(present: string[]): (path: string) => Promise<boolean> {
  const set = new Set(present);
  return async (path: string) => set.has(path);
}

describe("detectEditors", () => {
  it("命中集合：仅返回存在的编辑器，保持候选顺序，附 .app 绝对路径", async () => {
    const exists = existsFrom([
      `${APPS}/Visual Studio Code.app`,
      `${APPS}/Zed.app`,
      `${APPS}/Cursor.app`,
    ]);
    const hits = await detectEditors([APPS], exists);
    // 候选顺序为 vscode → cursor → … → zed，结果须按该顺序而非传入顺序
    expect(hits.map((h) => h.id)).toEqual(["vscode", "cursor", "zed"]);
    expect(hits[0]).toEqual({
      id: "vscode",
      name: "Visual Studio Code",
      appPath: `${APPS}/Visual Studio Code.app`,
    });
    expect(hits.find((h) => h.id === "zed")?.appPath).toBe(`${APPS}/Zed.app`);
  });

  it("全部缺失：返回空表", async () => {
    const hits = await detectEditors([APPS], existsFrom([]));
    expect(hits).toEqual([]);
  });

  it("intellij：两个包名任一命中即可（正式版）", async () => {
    const hits = await detectEditors([APPS], existsFrom([`${APPS}/IntelliJ IDEA.app`]));
    expect(hits.map((h) => h.id)).toEqual(["intellij"]);
    expect(hits[0].appPath).toBe(`${APPS}/IntelliJ IDEA.app`);
  });

  it("intellij：CE 版包名也算命中", async () => {
    const hits = await detectEditors([APPS], existsFrom([`${APPS}/IntelliJ IDEA CE.app`]));
    expect(hits.map((h) => h.id)).toEqual(["intellij"]);
    expect(hits[0].appPath).toBe(`${APPS}/IntelliJ IDEA CE.app`);
  });

  it("多扫描目录：~/Applications 命中也计入，且优先取首个命中的目录", async () => {
    const home = "/Users/me/Applications";
    const exists = existsFrom([`${home}/Cursor.app`]);
    const hits = await detectEditors([APPS, home], exists);
    expect(hits).toEqual([{ id: "cursor", name: "Cursor", appPath: `${home}/Cursor.app` }]);
  });
});

describe("detectCached", () => {
  beforeEach(() => resetEditorCache());

  it("非 darwin：返回空表且不调用 detect", async () => {
    const detect = vi.fn(async () => [{ id: "vscode", name: "Visual Studio Code", appPath: "/x" }]);
    const entries = await detectCached(detect, () => 0, "win32");
    expect(entries).toEqual([]);
    expect(detect).not.toHaveBeenCalled();
  });

  it("TTL 内复用缓存：detect 只跑一次", async () => {
    const detect = vi.fn(async () => [{ id: "zed", name: "Zed", appPath: "/Applications/Zed.app" }]);
    let now = 1000;
    const clock = () => now;

    const a = await detectCached(detect, clock, "darwin");
    now += CACHE_TTL_MS - 1; // 仍在 TTL 窗口内
    const b = await detectCached(detect, clock, "darwin");

    expect(detect).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("TTL 过期：detect 重新探测", async () => {
    const detect = vi.fn(async () => [{ id: "zed", name: "Zed", appPath: "/Applications/Zed.app" }]);
    let now = 1000;
    const clock = () => now;

    await detectCached(detect, clock, "darwin");
    now += CACHE_TTL_MS; // 刚好到达 TTL 边界（>= 视为过期）
    await detectCached(detect, clock, "darwin");

    expect(detect).toHaveBeenCalledTimes(2);
  });
});
