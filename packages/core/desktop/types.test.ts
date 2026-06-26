import { describe, expect, it } from "vitest";
import {
  AGENT_MODELS,
  DEFAULT_MODEL,
  PERMISSION_MODES,
  DEFAULT_DIRECTORY_GRANTS,
  DIRECTORY_GRANT_KINDS,
  type ConcretePermissionMode,
} from "./types";

describe("desktop agent model config", () => {
  it("Codex exposes selectable recommended models", () => {
    expect(AGENT_MODELS.codex.map((m) => m.value)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
  });

  it("Codex default model is selectable", () => {
    expect(AGENT_MODELS.codex.some((m) => m.value === DEFAULT_MODEL.codex)).toBe(true);
  });
});

describe("permission mode 与目录授权常量", () => {
  it("PERMISSION_MODES 含 auto,且历史内部值未改名(防回归)", () => {
    expect(PERMISSION_MODES).toEqual(["plan", "accept-edits", "full-auto", "auto"]);
  });

  it("DIRECTORY_GRANT_KINDS 四类且顺序稳定", () => {
    expect(DIRECTORY_GRANT_KINDS).toEqual(["workspace", "generated-images", "custom", "all-files"]);
  });

  it("默认目录授权仅工作区", () => {
    expect(DEFAULT_DIRECTORY_GRANTS).toEqual([{ kind: "workspace" }]);
  });

  it("ConcretePermissionMode 不含 auto(编译期约束)", () => {
    // @ts-expect-error auto 不可赋给 ConcretePermissionMode
    const bad: ConcretePermissionMode = "auto";
    void bad;
    const ok: ConcretePermissionMode = "accept-edits";
    expect(ok).toBe("accept-edits");
  });
});
