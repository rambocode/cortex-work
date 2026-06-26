import { describe, expect, it } from "vitest";
import { resolveGrantDirs, clampByMode } from "./resolveGrants";
import type { DirectoryGrant } from "../desktop/types";

const HOME = "/Users/x";
const CWD = "/proj";
const GEN_IMG = `${HOME}/.codex/generated_images`;

describe("resolveGrantDirs", () => {
  it("workspace → cwd", () => {
    const r = resolveGrantDirs([{ kind: "workspace" }], CWD, HOME);
    expect(r.workspace).toBe(CWD);
    expect(r.allFiles).toBe(false);
  });

  it("generated-images 展开为 codex 产图目录(含 app 媒体目录)", () => {
    const r = resolveGrantDirs([{ kind: "generated-images" }], CWD, HOME);
    expect(r.generatedImages).toContain(GEN_IMG);
  });

  it("custom 取 grant.dirs", () => {
    const r = resolveGrantDirs([{ kind: "custom", dirs: ["/a", "/b"] }], CWD, HOME);
    expect(r.custom).toEqual(["/a", "/b"]);
  });

  it("all-files → allFiles 哨兵", () => {
    const r = resolveGrantDirs([{ kind: "all-files" }], CWD, HOME);
    expect(r.allFiles).toBe(true);
  });

  it("空 grants 兜底为默认(仅工作区)", () => {
    expect(resolveGrantDirs([], CWD, HOME).workspace).toBe(CWD);
    expect(resolveGrantDirs(undefined, CWD, HOME).workspace).toBe(CWD);
  });
});

describe("clampByMode", () => {
  const grants: DirectoryGrant[] = [
    { kind: "workspace" },
    { kind: "generated-images" },
    { kind: "custom", dirs: ["/a"] },
  ];

  it("plan:全部进 readable,writable 恒空", () => {
    const resolved = resolveGrantDirs(grants, CWD, HOME);
    const c = clampByMode("plan", resolved);
    expect(c.writableExtraDirs).toEqual([]);
    expect(c.readableExtraDirs).toEqual(expect.arrayContaining([CWD, GEN_IMG, "/a"]));
  });

  it("accept-edits:workspace+custom+generated-images 进 writable", () => {
    const resolved = resolveGrantDirs(grants, CWD, HOME);
    const c = clampByMode("accept-edits", resolved);
    expect(c.writableExtraDirs).toEqual(expect.arrayContaining([CWD, GEN_IMG, "/a"]));
  });

  it("full-auto + all-files:不产 extraDirs(sandbox 已全开)", () => {
    const resolved = resolveGrantDirs([{ kind: "all-files" }], CWD, HOME);
    const c = clampByMode("full-auto", resolved);
    expect(c.writableExtraDirs).toEqual([]);
    expect(c.readableExtraDirs).toEqual([]);
  });

  it("all-files 在非 full-auto 被忽略,只按其余授权钳制", () => {
    const resolved = resolveGrantDirs([{ kind: "all-files" }, { kind: "custom", dirs: ["/a"] }], CWD, HOME);
    const c = clampByMode("accept-edits", resolved);
    expect(c.writableExtraDirs).toEqual(["/a"]);
  });
});
