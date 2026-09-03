// 环境快照纯逻辑单测:探测脚本的安全护栏、输出解析的容错、提示词块的确定性渲染。
import { describe, expect, it } from "vitest";

import {
  PROBED_CLI_TOOLS,
  PROBED_PYTHON_MODULES,
  buildProbeScript,
  parseProbeOutput,
  renderEnvironmentBlock,
  type EnvironmentSnapshot,
} from "./snapshot";

const base = { platform: "darwin", arch: "arm64", shell: "/bin/zsh" };

describe("buildProbeScript", () => {
  it("macOS 无 CLT 时不直接调用 /usr/bin/python3(避免弹系统安装框)", () => {
    const script = buildProbeScript();
    expect(script).toContain("xcode-select -p");
    expect(script).toContain('[ "$(command -v python3)" = /usr/bin/python3 ]');
    // git 同样是 CLT stub,清单里要跳过
    expect(script).toContain('[ "$c" = git ]');
  });

  it("探测清单里的模块与 CLI 都进了脚本", () => {
    const script = buildProbeScript();
    for (const m of PROBED_PYTHON_MODULES) expect(script).toContain(`"${m}"`);
    for (const t of PROBED_CLI_TOOLS) expect(script).toContain(t);
  });
});

describe("parseProbeOutput", () => {
  it("完整输出:版本、模块、node、CLI 各归其位,并过滤清单外的名字", () => {
    const stdout = [
      "__CORTEX_OS__",
      "26.0",
      "__CORTEX_PY__",
      "3.12.4",
      "requests,numpy,not_in_list",
      "__CORTEX_NODE__",
      "v22.12.0",
      "__CORTEX_CLI__",
      "git",
      "jq",
      "something-else",
      "",
    ].join("\n");
    expect(parseProbeOutput(stdout, base)).toEqual<EnvironmentSnapshot>({
      ...base,
      osVersion: "26.0",
      pythonVersion: "3.12.4",
      pythonModules: ["requests", "numpy"],
      nodeVersion: "v22.12.0",
      cliTools: ["git", "jq"],
    });
  });

  it("python / node 不可用时为 null,模块列表为空", () => {
    const stdout = ["__CORTEX_OS__", "__NONE__", "__CORTEX_PY__", "__NONE__", "__CORTEX_NODE__", "__NONE__", "__CORTEX_CLI__", "curl"].join("\n");
    const snap = parseProbeOutput(stdout, base);
    expect(snap.osVersion).toBeNull();
    expect(snap.pythonVersion).toBeNull();
    expect(snap.pythonModules).toEqual([]);
    expect(snap.nodeVersion).toBeNull();
    expect(snap.cliTools).toEqual(["curl"]);
  });

  it("输出被截断(超时)时,已拿到的段仍能解析,缺的段按不可用处理", () => {
    const stdout = ["__CORTEX_OS__", "15.6", "__CORTEX_PY__", "3.9.6"].join("\n");
    const snap = parseProbeOutput(stdout, base);
    expect(snap.osVersion).toBe("15.6");
    expect(snap.pythonVersion).toBe("3.9.6");
    expect(snap.pythonModules).toEqual([]);
    expect(snap.nodeVersion).toBeNull();
    expect(snap.cliTools).toEqual([]);
  });

  it("空输出也能得到基础快照,不抛错", () => {
    const snap = parseProbeOutput("", base);
    expect(snap.platform).toBe("darwin");
    expect(snap.pythonVersion).toBeNull();
  });
});

describe("renderEnvironmentBlock", () => {
  const snap: EnvironmentSnapshot = {
    ...base,
    osVersion: "26.0",
    pythonVersion: "3.12.4",
    pythonModules: ["requests"],
    nodeVersion: "v22.12.0",
    cliTools: ["git", "jq"],
  };

  it("渲染为英文 <environment> 块,明确列出已装与未装", () => {
    const block = renderEnvironmentBlock(snap);
    expect(block.startsWith("<environment>\n")).toBe(true);
    expect(block.endsWith("\n</environment>")).toBe(true);
    expect(block).toContain("OS: macOS 26.0 (darwin, arm64). Shell: /bin/zsh.");
    expect(block).toContain("Python: 3.12.4. Installed third-party modules: requests. NOT installed: bs4, lxml,");
    expect(block).toContain("Node: v22.12.0.");
    expect(block).toContain("CLI tools available: git, jq. Not found: rg,");
    expect(block).toContain("Do not install packages");
    // 系统提示词必须是英文:不得混入中文字符
    expect(/[一-鿿]/.test(block)).toBe(false);
  });

  it("python 缺失时明确写 NOT available,已装列表为空写 none", () => {
    const block = renderEnvironmentBlock({ ...snap, pythonVersion: null, pythonModules: [], cliTools: [] });
    expect(block).toContain("Python: python3 is NOT available.");
    expect(block).toContain("CLI tools available: none.");
  });

  it("同一快照两次渲染逐字节相同(prompt 缓存前缀稳定)", () => {
    expect(renderEnvironmentBlock(snap)).toBe(renderEnvironmentBlock({ ...snap }));
  });
});
