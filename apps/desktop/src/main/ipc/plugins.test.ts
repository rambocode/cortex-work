// plugins IPC handler 注册单测。mock electron ipcMain 捕获 handler，校验注册 + 委派到只读扫描。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: Handler) => handlers.set(ch, fn) },
}));

import { registerPluginHandlers } from "./plugins";

let base: string;
const prev = process.env.CORTEX_AGENTS_PLUGINS_ROOT;

beforeEach(() => {
  handlers.clear();
  base = mkdtempSync(join(tmpdir(), "plugins-ipc-"));
  process.env.CORTEX_AGENTS_PLUGINS_ROOT = base;
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  if (prev === undefined) delete process.env.CORTEX_AGENTS_PLUGINS_ROOT;
  else process.env.CORTEX_AGENTS_PLUGINS_ROOT = prev;
});

describe("registerPluginHandlers", () => {
  it("注册 plugins:list / marketplace:list 两个只读 channel", () => {
    registerPluginHandlers();
    expect(handlers.has("plugins:list")).toBe(true);
    expect(handlers.has("marketplace:list")).toBe(true);
  });

  it("plugins:list 委派到扫描，返回已装插件", async () => {
    const dir = join(base, "plugins", "demo", ".claude-plugin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "Demo" }));
    registerPluginHandlers();
    const res = (await handlers.get("plugins:list")!()) as { items: unknown[]; rootExists: boolean };
    expect(res.rootExists).toBe(true);
    expect(res.items).toHaveLength(1);
  });

  it("marketplace:list 委派到索引读取", async () => {
    writeFileSync(join(base, "marketplace.json"), JSON.stringify({ plugins: [{ name: "X", gitUrl: "https://e/x.git" }] }));
    registerPluginHandlers();
    const res = (await handlers.get("marketplace:list")!()) as { items: unknown[] };
    expect(res.items).toHaveLength(1);
  });
});
