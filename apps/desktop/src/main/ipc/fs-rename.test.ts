// fs:renameEntry handler 单测:正常重命名 + 目标已存在时报错不覆盖。
// 复用 watch.test.ts 的 electron mock 思路:捕获 ipcMain.handle 注册的 handler,
// 用真实临时目录跑真实 fs;getPersistedState 桩接把临时根并入白名单(assertAllowed 放行)。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  root: "",
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  // documentsCortexDir()（allowedRoots 用）走 app.getPath("documents");桩成临时目录即可。
  app: { getPath: () => tmpdir() },
  dialog: {},
  shell: {},
}));

// 白名单只含本测临时根:renameEntry 的 from/to 都在其内 → assertAllowed 放行。
vi.mock("./store", () => ({
  getPersistedState: vi.fn(async () => ({ promptRoot: mocks.root, projects: [] })),
}));

import { registerFsHandlers } from "./fs";

let tmp = "";

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "writing-rename-"));
  mocks.root = tmp;
  registerFsHandlers();
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// 便捷 invoke:取出捕获的 handler,以 (event=null, ...args) 调用。
function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`handler 未注册: ${channel}`);
  return handler(null, ...args);
}

describe("fs:renameEntry", () => {
  it("正常重命名:源移动到新名、旧名消失", async () => {
    const from = join(tmp, "a.md");
    const to = join(tmp, "b.md");
    await fsp.writeFile(from, "hello", "utf8");
    await invoke("fs:renameEntry", from, to);
    expect(await fsp.readFile(to, "utf8")).toBe("hello");
    await expect(fsp.stat(from)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("目标已存在:报错且不覆盖目标内容", async () => {
    const from = join(tmp, "src.md");
    const to = join(tmp, "dst.md");
    await fsp.writeFile(from, "SRC", "utf8");
    await fsp.writeFile(to, "DST", "utf8");
    await expect(invoke("fs:renameEntry", from, to)).rejects.toThrow(/目标已存在/);
    // 目标内容不变,源仍在(未被消费)。
    expect(await fsp.readFile(to, "utf8")).toBe("DST");
    expect(await fsp.readFile(from, "utf8")).toBe("SRC");
  });
});
