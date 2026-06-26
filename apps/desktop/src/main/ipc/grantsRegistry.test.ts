import { describe, expect, it, vi, beforeEach } from "vitest";

// 受控的持久化会话与 realpath 映射。
const state: { sessions: { id: string; directoryGrants?: unknown[] }[] } = { sessions: [] };
const realMap: Record<string, string> = {};

vi.mock("./store", () => ({
  getPersistedState: () => Promise.resolve(state),
}));
vi.mock("os", () => ({ homedir: () => "/Users/x" }));
vi.mock("fs", () => ({
  promises: {
    // realpath:命中映射(模拟符号链接解析)→ 目标;未命中且在白名单里 → 原样;否则抛(不存在)。
    realpath: (p: string) => {
      if (realMap[p]) return Promise.resolve(realMap[p]);
      if (p.startsWith("/exists")) return Promise.resolve(p);
      if (p === "/Users/x/.codex/generated_images") return Promise.resolve(p);
      return Promise.reject(new Error("ENOENT"));
    },
  },
}));

import { sessionGrantedDirs } from "./grantsRegistry";

describe("sessionGrantedDirs", () => {
  beforeEach(() => {
    state.sessions = [];
    for (const k of Object.keys(realMap)) delete realMap[k];
  });

  it("无 sessionId → 空", async () => {
    expect(await sessionGrantedDirs(undefined)).toEqual([]);
  });

  it("查无会话 → 空", async () => {
    expect(await sessionGrantedDirs("nope")).toEqual([]);
  });

  it("generated-images 展开为 codex 产图目录(规范化)", async () => {
    state.sessions = [{ id: "s1", directoryGrants: [{ kind: "generated-images" }] }];
    expect(await sessionGrantedDirs("s1")).toEqual(["/Users/x/.codex/generated_images"]);
  });

  it("custom 取 dirs;workspace/all-files 不展开", async () => {
    state.sessions = [
      {
        id: "s1",
        directoryGrants: [
          { kind: "workspace" },
          { kind: "custom", dirs: ["/exists/a", "/exists/b"] },
          { kind: "all-files" },
        ],
      },
    ];
    expect(await sessionGrantedDirs("s1")).toEqual(["/exists/a", "/exists/b"]);
  });

  it("custom symlink 经 realpath 解析到真实目标(防越权)", async () => {
    realMap["/link"] = "/exists/real-target";
    state.sessions = [{ id: "s1", directoryGrants: [{ kind: "custom", dirs: ["/link"] }] }];
    expect(await sessionGrantedDirs("s1")).toEqual(["/exists/real-target"]);
  });

  it("不存在的 custom 路径被丢弃(realpath 失败)", async () => {
    state.sessions = [{ id: "s1", directoryGrants: [{ kind: "custom", dirs: ["/nope"] }] }];
    expect(await sessionGrantedDirs("s1")).toEqual([]);
  });
});
