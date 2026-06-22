// scanInstalledPlugins 单测。用 CORTEX_AGENTS_PLUGINS_ROOT 指向临时目录（locate 无 electron 依赖）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanInstalledPlugins } from "./scan";

let base: string;
const prev = process.env.CORTEX_AGENTS_PLUGINS_ROOT;

function makePlugin(root: string, id: string, name: string): void {
  const dir = join(root, "plugins", id, ".codex-plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name, interface: { displayName: name } }));
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "plugin-scan-"));
  process.env.CORTEX_AGENTS_PLUGINS_ROOT = base;
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  if (prev === undefined) delete process.env.CORTEX_AGENTS_PLUGINS_ROOT;
  else process.env.CORTEX_AGENTS_PLUGINS_ROOT = prev;
});

describe("scanInstalledPlugins", () => {
  it("枚举 plugins/<id>/ 已装插件，按 displayName 排序，rootExists=true", async () => {
    makePlugin(base, "zeta", "Zeta");
    makePlugin(base, "alpha", "Alpha");
    mkdirSync(join(base, "plugins", "not-a-plugin"), { recursive: true }); // 无 manifest → 跳过
    const res = await scanInstalledPlugins();
    expect(res.rootExists).toBe(true);
    expect(res.items.map((p) => p.manifest.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("plugins 目录不存在 → 空列表 + rootExists=false，不抛", async () => {
    const res = await scanInstalledPlugins();
    expect(res).toEqual({ items: [], rootExists: false });
  });
});
