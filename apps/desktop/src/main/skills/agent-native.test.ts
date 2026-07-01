// agentNativePluginRoots 单测:发现 claude 已装插件 / codex vendor+memories 的 skill 根。
// home 注入临时目录,不必 mock os;electron 仅因 ScanRoot 从 locate.ts 传递引入,mock 掉。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/app", getPath: () => "/userData" } }));

import { agentNativePluginRoots } from "./agent-native";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-native-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("agentNativePluginRoots — claude", () => {
  it("读 installed_plugins.json,产出每个 installPath 下存在的 skills/ 根", () => {
    const ipA = join(home, "cache", "mp", "plugin-a", "1.0.0");
    const ipB = join(home, "cache", "mp", "plugin-b", "2.0.0");
    mkdirSync(join(ipA, "skills"), { recursive: true });
    mkdirSync(ipB, { recursive: true }); // plugin-b 无 skills 子目录
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "a@mp": [{ installPath: ipA }], "b@mp": [{ installPath: ipB }] } }),
    );
    const roots = agentNativePluginRoots("claude", home);
    expect(roots).toEqual([{ path: join(ipA, "skills"), scope: "global", origin: "shared" }]);
  });

  it("同插件多版本记录的 installPath 去重", () => {
    const ip = join(home, "cache", "mp", "dup", "1.0.0");
    mkdirSync(join(ip, "skills"), { recursive: true });
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "dup@mp": [{ installPath: ip }, { installPath: ip }] } }),
    );
    expect(agentNativePluginRoots("claude", home)).toHaveLength(1);
  });

  it("installed_plugins.json 不存在 → [](容错)", () => {
    expect(agentNativePluginRoots("claude", home)).toEqual([]);
  });

  it("installed_plugins.json 非法 JSON → [](容错不抛)", () => {
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "{ not json");
    expect(agentNativePluginRoots("claude", home)).toEqual([]);
  });
});

describe("agentNativePluginRoots — codex", () => {
  it("产出 .system(系统内置,如 imagegen)、.curated、memories 三个固定根", () => {
    const sys = join(home, ".codex", "skills", ".system");
    const curated = join(home, ".codex", "vendor_imports", "skills", "skills", ".curated");
    const memories = join(home, ".codex", "memories", "skills");
    mkdirSync(join(sys, "imagegen"), { recursive: true }); // .system/imagegen
    mkdirSync(curated, { recursive: true });
    mkdirSync(memories, { recursive: true });
    const paths = agentNativePluginRoots("codex", home).map((r) => r.path);
    expect(paths).toContain(sys);
    expect(paths).toContain(curated);
    expect(paths).toContain(memories);
  });

  it("已装插件 cache/<catalog>/<plugin>/<version>/skills 经 glob 收集", () => {
    const skillsDir = join(home, ".codex", "plugins", "cache", "openai-curated", "canva", "3fdeeb49", "skills");
    mkdirSync(skillsDir, { recursive: true });
    // node_modules 不应被深入误收
    mkdirSync(join(home, ".codex", "plugins", "cache", "x", "y", "z", "node_modules", "skills"), { recursive: true });
    const paths = agentNativePluginRoots("codex", home).map((r) => r.path);
    expect(paths).toContain(skillsDir);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("全部源缺失 → [](容错)", () => {
    expect(agentNativePluginRoots("codex", home)).toEqual([]);
  });
});

describe("agentNativePluginRoots — pi", () => {
  it("pi → [](走自身 --skill 原生发现,不额外追加)", () => {
    expect(agentNativePluginRoots("pi", home)).toEqual([]);
  });
});
