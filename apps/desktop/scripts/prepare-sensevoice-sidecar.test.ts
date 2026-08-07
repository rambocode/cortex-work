import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptsRoot = import.meta.dirname;
const desktopRoot = join(scriptsRoot, "..");

describe("SenseVoice sidecar 构建护栏", () => {
  it("固定上游提交、支持矩阵并禁用 Metal", () => {
    const script = readFileSync(join(scriptsRoot, "prepare-sensevoice-sidecar.mjs"), "utf8");
    const cmake = readFileSync(join(desktopRoot, "native", "sensevoice-sidecar", "CMakeLists.txt"), "utf8");
    expect(script).toContain("runtime-llamacpp-v0.1.9");
    expect(script).toContain("9b918d74d7090b38211a6414c6ee08893a34afd4");
    expect(script).toContain('["darwin-arm64", "darwin-x64", "win32-x64"]');
    expect(cmake).toContain("8086439a4cea94c71a5dfb8fe4ad1546aebd640f");
    expect(cmake).toContain("set(GGML_METAL OFF");
    expect(cmake).toContain("set(GGML_NATIVE OFF");
  });
});
