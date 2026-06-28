import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadRoles, createRole, updateRole, deleteRole } from "./roles";

describe("roles CRUD", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "roles-test-"));
    path = join(dir, "roles.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadRoles 在文件不存在时返回 []", () => {
    expect(loadRoles(path)).toEqual([]);
  });

  it("loadRoles 在非法 JSON 时返回 []", () => {
    const { writeFileSync } = require("fs");
    writeFileSync(path, "not json", "utf8");
    expect(loadRoles(path)).toEqual([]);
  });

  it("createRole 新增角色后 loadRoles 包含该角色", () => {
    const role = createRole(
      { label: "设计师", agent: "claude", systemPrompt: "你是设计师" },
      path,
    );
    expect(role.label).toBe("设计师");
    expect(role.agent).toBe("claude");
    expect(role.systemPrompt).toBe("你是设计师");
    expect(role.id).toBeTruthy();
    expect(role.createdAt).toBeTruthy();

    const roles = loadRoles(path);
    expect(roles).toHaveLength(1);
    expect(roles[0].id).toBe(role.id);
  });

  it("createRole 处理 id 冲突", () => {
    const r1 = createRole({ label: "test", agent: "claude", systemPrompt: "" }, path);
    const r2 = createRole({ label: "test", agent: "codex", systemPrompt: "" }, path);
    expect(r1.id).not.toBe(r2.id);
    expect(loadRoles(path)).toHaveLength(2);
  });

  it("createRole 保存 color 和 avatar", () => {
    const role = createRole(
      { label: "test", agent: "claude", systemPrompt: "", color: "#ff0000", avatar: "🎨" },
      path,
    );
    expect(role.color).toBe("#ff0000");
    expect(role.avatar).toBe("🎨");
    const loaded = loadRoles(path)[0];
    expect(loaded.color).toBe("#ff0000");
    expect(loaded.avatar).toBe("🎨");
  });

  it("updateRole 只更新指定字段", () => {
    const role = createRole(
      { label: "原始", agent: "claude", systemPrompt: "原始 prompt" },
      path,
    );
    const updated = updateRole(role.id, { label: "更新后" }, path);
    expect(updated).not.toBeNull();
    expect(updated!.label).toBe("更新后");
    expect(updated!.agent).toBe("claude");
    expect(updated!.systemPrompt).toBe("原始 prompt");
    expect(updated!.updatedAt).not.toBe(role.updatedAt);
  });

  it("updateRole 对不存在的 id 返回 null", () => {
    expect(updateRole("nonexistent", { label: "x" }, path)).toBeNull();
  });

  it("deleteRole 移除对应 id", () => {
    const role = createRole({ label: "待删", agent: "claude", systemPrompt: "" }, path);
    expect(deleteRole(role.id, path)).toBe(true);
    expect(loadRoles(path)).toHaveLength(0);
  });

  it("deleteRole id 不存在时返回 false", () => {
    expect(deleteRole("nonexistent", path)).toBe(false);
  });

  it("loadRoles 跳过非法条目并保留合法条目", () => {
    const { writeFileSync } = require("fs");
    writeFileSync(
      path,
      JSON.stringify([
        { id: "ok", label: "OK", agent: "claude", systemPrompt: "" },
        { id: 123, label: "bad" },
        { id: "also-ok", label: "Also OK", agent: "codex", systemPrompt: "test" },
      ]),
      "utf8",
    );
    const roles = loadRoles(path);
    expect(roles).toHaveLength(2);
    expect(roles[0].id).toBe("ok");
    expect(roles[1].id).toBe("also-ok");
  });

  it("loadRoles 去重保留首个", () => {
    const { writeFileSync } = require("fs");
    writeFileSync(
      path,
      JSON.stringify([
        { id: "dup", label: "First", agent: "claude", systemPrompt: "1" },
        { id: "dup", label: "Second", agent: "codex", systemPrompt: "2" },
      ]),
      "utf8",
    );
    const roles = loadRoles(path);
    expect(roles).toHaveLength(1);
    expect(roles[0].label).toBe("First");
  });

  it("文件写穿验证：创建后直接读 JSON 文件一致", () => {
    createRole({ label: "persist", agent: "pi", systemPrompt: "test" }, path);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].label).toBe("persist");
    expect(raw[0].agent).toBe("pi");
  });
});
