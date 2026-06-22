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

  it("defaultPrompt 为数组（真实 OpenAI 插件形态）→ 取首个非空项", async () => {
    const dir = join(base, "array-prompt");
    writeJson(dir, ".codex-plugin/plugin.json", {
      name: "p",
      interface: { defaultPrompt: ["", "Design a new landing page for my SaaS."] },
    });
    const p = await parsePluginManifest(dir);
    expect(p?.manifest.defaultPrompt).toBe("Design a new landing page for my SaaS.");
  });

  it("logo→iconDataUrl(管理) / composerIcon→composerIconDataUrl(对话),语义分离", async () => {
    const dir = join(base, "two-icons");
    writeJson(dir, ".codex-plugin/plugin.json", {
      name: "p",
      interface: { logo: "./assets/logo.png", composerIcon: "./assets/composer.svg" },
    });
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(dir, "assets", "composer.svg"), "<svg/>");
    const p = await parsePluginManifest(dir);
    expect(p?.iconDataUrl).toMatch(/^data:image\/png;base64,/); // 管理用 logo
    expect(p?.composerIconDataUrl).toMatch(/^data:image\/svg\+xml;base64,/); // 对话用 composerIcon
  });

  it("缺 logo 时管理图标回退 composerIcon；超 256KiB 或越界 → 不内联", async () => {
    // 无 logo,仅 composerIcon → iconDataUrl 回退到它
    const fb = join(base, "icon-fallback");
    writeJson(fb, ".codex-plugin/plugin.json", { name: "p", interface: { composerIcon: "./assets/icon.svg" } });
    mkdirSync(join(fb, "assets"), { recursive: true });
    writeFileSync(join(fb, "assets", "icon.svg"), "<svg/>");
    expect((await parsePluginManifest(fb))?.iconDataUrl).toMatch(/^data:image\/svg\+xml/);

    // 超 256KiB:回退(不内联)
    const big = join(base, "big-icon");
    writeJson(big, ".codex-plugin/plugin.json", { name: "p", interface: { logo: "./assets/big.png" } });
    mkdirSync(join(big, "assets"), { recursive: true });
    writeFileSync(join(big, "assets", "big.png"), Buffer.alloc(300 * 1024));
    expect((await parsePluginManifest(big))?.iconDataUrl).toBeUndefined();

    // 越界 ../：拒绝内联
    const esc = join(base, "esc-icon");
    writeJson(esc, ".codex-plugin/plugin.json", { name: "p", interface: { logo: "../../secret.png" } });
    expect((await parsePluginManifest(esc))?.iconDataUrl).toBeUndefined();
  });

  it("captures developer/website/privacy/terms/longDescription", async () => {
    const dir = join(base, "rich-meta");
    writeJson(dir, ".codex-plugin/plugin.json", {
      name: "browser",
      author: { name: "OpenAI" },
      homepage: "https://gh/openai",
      license: "Proprietary",
      keywords: ["browser", "automation"],
      interface: {
        shortDescription: "短描述",
        longDescription: "长描述正文",
        developerName: "OpenAI",
        websiteURL: "https://openai.com/",
        privacyPolicyURL: "https://openai.com/privacy",
        termsOfServiceURL: "https://openai.com/terms",
      },
    });
    const m = (await parsePluginManifest(dir))!.manifest;
    expect(m.description).toBe("短描述"); // shortDescription 优先
    expect(m.longDescription).toBe("长描述正文");
    expect(m.developer).toBe("OpenAI");
    expect(m.website).toBe("https://openai.com/");
    expect(m.privacyUrl).toBe("https://openai.com/privacy");
    expect(m.termsUrl).toBe("https://openai.com/terms");
    expect(m.license).toBe("Proprietary");
    expect(m.keywords).toEqual(["browser", "automation"]);
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
