// buildClaudeSkillBridge / slugifyClaudeSkillName 单测(U1)。用真实 fs 临时目录建 skill target 与
// 桥接根,校验 symlink 命名、目标、清洗、碰撞消歧、缺失跳过、重复调用清空等场景。
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InjectableSkill } from "@cortex-work/core";

import { buildClaudeSkillBridge, slugifyClaudeSkillName } from "./claude-bridge";

let root: string; // 每个用例独立的临时根
let bridgeRoot: string;
const skillsSub = join(".claude", "skills");

// 在临时根下建一个真实 skill 目录,返回其绝对路径(作为 record.dir)。
function makeSkillDir(name: string): string {
  const dir = join(root, "targets", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-bridge-"));
  bridgeRoot = join(root, "bridge");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("slugifyClaudeSkillName", () => {
  it("大写/空格 → 小写连字符 slug", () => {
    expect(slugifyClaudeSkillName("My Cool Skill")).toBe("my-cool-skill");
  });
  it("路径分隔符 / .. / 控制字符折叠为连字符并去首尾", () => {
    expect(slugifyClaudeSkillName("../my/skill")).toBe("my-skill");
    expect(slugifyClaudeSkillName("deploy")).toBe("deploy");
  });
  it("全符号 name → 空串(由调用方兜底)", () => {
    expect(slugifyClaudeSkillName("!@#$%")).toBe("");
  });
});

describe("buildClaudeSkillBridge", () => {
  it("2 条记录 → 桥接目录下各建一个指向正确 dir 的 symlink", () => {
    const a = makeSkillDir("alpha");
    const b = makeSkillDir("beta");
    const records: InjectableSkill[] = [
      { name: "alpha", dir: a },
      { name: "beta", dir: b },
    ];
    const out = buildClaudeSkillBridge(records, bridgeRoot);
    expect(out).toBe(bridgeRoot);
    const skillsDir = join(bridgeRoot, skillsSub);
    expect(readdirSync(skillsDir).sort()).toEqual(["alpha", "beta"]);
    expect(lstatSync(join(skillsDir, "alpha")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(skillsDir, "alpha"))).toBe(realpathSync(a));
    expect(realpathSync(join(skillsDir, "beta"))).toBe(realpathSync(b));
  });

  it("空数组 → 返回 undefined 且不创建任何目录", () => {
    const out = buildClaudeSkillBridge([], bridgeRoot);
    expect(out).toBeUndefined();
    expect(existsSync(bridgeRoot)).toBe(false);
  });

  it("name 含 / .. 空格 → 落地为安全 slug 目录名,不越权、不冲突", () => {
    const dir = makeSkillDir("weird");
    const out = buildClaudeSkillBridge([{ name: "../My Weird/Skill", dir }], bridgeRoot);
    expect(out).toBe(bridgeRoot);
    const names = readdirSync(join(bridgeRoot, skillsSub));
    expect(names).toEqual(["my-weird-skill"]);
    // 目录名不含路径分隔符 → 链接不逃逸出 skills 目录
    expect(names[0]).not.toContain("/");
    expect(names[0]).not.toContain("..");
  });

  it("两条不同 name 归一到同一 slug → 各自建链,消歧后缀生效不互相覆盖", () => {
    const a = makeSkillDir("collide-a");
    const b = makeSkillDir("collide-b");
    const out = buildClaudeSkillBridge(
      [
        { name: "my/skill", dir: a },
        { name: "my-skill", dir: b },
      ],
      bridgeRoot,
    );
    expect(out).toBe(bridgeRoot);
    const skillsDir = join(bridgeRoot, skillsSub);
    const names = readdirSync(skillsDir);
    expect(names).toHaveLength(2); // 未互相覆盖
    // 先到者拿到裸 slug,后到者带 hash 后缀
    expect(names).toContain("my-skill");
    const suffixed = names.find((n) => n !== "my-skill")!;
    expect(suffixed.startsWith("my-skill-")).toBe(true);
    // 两个链接分别指向各自的 dir
    expect(realpathSync(join(skillsDir, "my-skill"))).toBe(realpathSync(a));
    expect(realpathSync(join(skillsDir, suffixed))).toBe(realpathSync(b));
  });

  it("目标目录不存在(被手动删除)→ 跳过该条,其余仍建链,正常返回", () => {
    const good = makeSkillDir("good");
    const missing = join(root, "targets", "ghost"); // 未创建
    const out = buildClaudeSkillBridge(
      [
        { name: "ghost", dir: missing },
        { name: "good", dir: good },
      ],
      bridgeRoot,
    );
    expect(out).toBe(bridgeRoot);
    expect(readdirSync(join(bridgeRoot, skillsSub))).toEqual(["good"]);
  });

  it("全部目标缺失 → 无有效链接,返回 undefined", () => {
    const out = buildClaudeSkillBridge([{ name: "ghost", dir: join(root, "nope") }], bridgeRoot);
    expect(out).toBeUndefined();
  });

  it("重复调用 → 旧 symlink 被清空,只保留本轮记录", () => {
    const a = makeSkillDir("first");
    const b = makeSkillDir("second");
    buildClaudeSkillBridge([{ name: "first", dir: a }], bridgeRoot);
    expect(readdirSync(join(bridgeRoot, skillsSub))).toEqual(["first"]);
    // 第二轮换成另一批 skill,旧的 first 应被清掉
    const out = buildClaudeSkillBridge([{ name: "second", dir: b }], bridgeRoot);
    expect(out).toBe(bridgeRoot);
    expect(readdirSync(join(bridgeRoot, skillsSub))).toEqual(["second"]);
  });

  // U6 去重(KTD5):claude 私有原生根(origin==="agent")下的 skill 由 claude 自发现,桥接不再重复建链。
  it("origin==='agent' 的记录不进桥接(claude 自发现),只桥接 shared/缺省", () => {
    const nativeDir = makeSkillDir("native");
    const sharedDir = makeSkillDir("shared");
    const out = buildClaudeSkillBridge(
      [
        { name: "native", dir: nativeDir, origin: "agent" },
        { name: "shared", dir: sharedDir, origin: "shared" },
      ],
      bridgeRoot,
    );
    expect(out).toBe(bridgeRoot);
    expect(readdirSync(join(bridgeRoot, skillsSub))).toEqual(["shared"]);
  });

  it("全部为 origin==='agent' → 无桥接内容,返回 undefined(全交 claude 原生发现)", () => {
    const d = makeSkillDir("only-native");
    const out = buildClaudeSkillBridge([{ name: "only-native", dir: d, origin: "agent" }], bridgeRoot);
    expect(out).toBeUndefined();
  });
});
