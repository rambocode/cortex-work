import { describe, expect, it } from "vitest";
import { assembleModeGrants } from "./spawnAssembly";

const HOME = "/Users/x";
const CWD = "/proj";

describe("assembleModeGrants", () => {
  it("auto 按当轮 prompt 解析具体档(adapter 永不见 auto)", () => {
    const fix = assembleModeGrants({
      permissionMode: "auto",
      directoryGrants: [{ kind: "workspace" }],
      prompt: "修复登录 bug",
      cwd: CWD,
      home: HOME,
    });
    expect(fix.permissionMode).toBe("accept-edits");
    const ask = assembleModeGrants({
      permissionMode: "auto",
      directoryGrants: [{ kind: "workspace" }],
      prompt: "解释这段代码",
      cwd: CWD,
      home: HOME,
    });
    expect(ask.permissionMode).toBe("plan");
  });

  it("accept-edits + generated-images → 可写含 codex 产图目录", () => {
    const r = assembleModeGrants({
      permissionMode: "accept-edits",
      directoryGrants: [{ kind: "workspace" }, { kind: "generated-images" }],
      prompt: "改一下",
      cwd: CWD,
      home: HOME,
    });
    expect(r.writableExtraDirs).toContain(`${HOME}/.codex/generated_images`);
  });

  it("plan 档:writable 恒空", () => {
    const r = assembleModeGrants({
      permissionMode: "plan",
      directoryGrants: [{ kind: "custom", dirs: ["/a"] }],
      prompt: "x",
      cwd: CWD,
      home: HOME,
    });
    expect(r.writableExtraDirs).toEqual([]);
    expect(r.readableExtraDirs).toContain("/a");
  });

  it("home 缺省(web/旧壳):跳过 generated-images,其余授权照常", () => {
    const r = assembleModeGrants({
      permissionMode: "accept-edits",
      directoryGrants: [{ kind: "workspace" }, { kind: "generated-images" }, { kind: "custom", dirs: ["/a"] }],
      prompt: "改",
      cwd: CWD,
      home: undefined,
    });
    expect(r.writableExtraDirs).toContain(CWD);
    expect(r.writableExtraDirs).toContain("/a");
    expect(r.writableExtraDirs.some((d) => d.includes("generated_images"))).toBe(false);
  });
});
