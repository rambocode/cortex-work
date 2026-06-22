// parsePluginManifest 回退链单测。真实临时目录写 manifest / SKILL.md，无 electron 依赖。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePluginManifest } from "./manifest";

let base: string;

function writeJson(dir: string, rel: string, obj: unknown): void {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(obj));
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "plugin-manifest-"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("parsePluginManifest", () => {
  it("优先解析 .codex-plugin/plugin.json，映射 interface 字段 + skillsDir", async () => {
    const dir = join(base, "codex-plugin");
    writeJson(dir, ".codex-plugin/plugin.json", {
      name: "build-web-apps",
      version: "1.2.0",
      skills: "./skills/",
      interface: { displayName: "Build Web Apps", category: "Developer Tools", capabilities: ["Read", "Write"], defaultPrompt: "做个落地页" },
    });
    mkdirSync(join(dir, "skills", "frontend"), { recursive: true });
    writeFileSync(join(dir, "skills", "frontend", "SKILL.md"), "---\nname: frontend\n---\n");

    const p = await parsePluginManifest(dir);
    expect(p?.manifestKind).toBe("codex");
    expect(p?.manifest.name).toBe("build-web-apps");
    expect(p?.manifest.displayName).toBe("Build Web Apps");
    expect(p?.manifest.version).toBe("1.2.0");
    expect(p?.manifest.category).toBe("Developer Tools");
    expect(p?.manifest.capabilities).toEqual(["Read", "Write"]);
    expect(p?.manifest.defaultPrompt).toBe("做个落地页");
    expect(p?.skillsDir).toBe(join(dir, "skills"));
  });

  it("无 .codex-plugin，回退 .claude-plugin/plugin.json", async () => {
    const dir = join(base, "claude-plugin");
    writeJson(dir, ".claude-plugin/plugin.json", { name: "documents", description: "文档" });
    const p = await parsePluginManifest(dir);
    expect(p?.manifestKind).toBe("claude");
    expect(p?.manifest.name).toBe("documents");
    expect(p?.manifest.description).toBe("文档");
    expect(p?.skillsDir).toBeUndefined(); // 无 skills/ 目录
  });

  it("二者皆无、有 SKILL.md → 回退 frontmatter，skillsDir = 目录本身", async () => {
    const dir = join(base, "skill-fallback");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: commit-helper\ndescription: 生成提交信息\n---\n");
    const p = await parsePluginManifest(dir);
    expect(p?.manifestKind).toBe("skill-fallback");
    expect(p?.manifest.name).toBe("commit-helper");
    expect(p?.skillsDir).toBe(dir);
  });

  it("manifest JSON 非法 → 回退到下一档（SKILL.md）", async () => {
    const dir = join(base, "bad-json");
    mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
    writeFileSync(join(dir, ".codex-plugin", "plugin.json"), "{ not valid json");
    writeFileSync(join(dir, "SKILL.md"), "---\nname: fallback-ok\n---\n");
    const p = await parsePluginManifest(dir);
    expect(p?.manifestKind).toBe("skill-fallback");
    expect(p?.manifest.name).toBe("fallback-ok");
  });

  it("无任何可识别 manifest → null", async () => {
    const dir = join(base, "empty");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "nothing here");
    expect(await parsePluginManifest(dir)).toBeNull();
  });

  it("skills 字段指向包外（../）→ skillsDir 拒置，其余元数据仍解析", async () => {
    const dir = join(base, "escape-skills");
    writeJson(dir, ".codex-plugin/plugin.json", { name: "evil", skills: "../../outside" });
    const p = await parsePluginManifest(dir);
    expect(p?.manifest.name).toBe("evil");
    expect(p?.skillsDir).toBeUndefined();
  });

  it("id 恒取目录名", async () => {
    const dir = join(base, "my-plugin-id");
    writeJson(dir, ".claude-plugin/plugin.json", { name: "X" });
    const p = await parsePluginManifest(dir);
    expect(p?.manifest.id).toBe("my-plugin-id");
  });

  it("id 不采信 manifest 声明的 json.id（防启停键碰撞，ADV-001）", async () => {
    const dirA = join(base, "real-dir-a");
    const dirB = join(base, "real-dir-b");
    writeJson(dirA, ".codex-plugin/plugin.json", { id: "shared-id", name: "A" });
    writeJson(dirB, ".codex-plugin/plugin.json", { id: "shared-id", name: "B" });
    const a = await parsePluginManifest(dirA);
    const b = await parsePluginManifest(dirB);
    // 两个插件声明相同 json.id，但身份键取目录名 → 互不碰撞。
    expect(a?.manifest.id).toBe("real-dir-a");
    expect(b?.manifest.id).toBe("real-dir-b");
  });
});
