import { describe, expect, it } from "vitest";
import { buildContextSnippet, guessHome, shellQuotePath, toTildePath, wrapBracketedPaste } from "./sendContext";

describe("guessHome / toTildePath", () => {
  it("macOS /Users/<u> 前缀替换为 ~", () => {
    expect(guessHome("/Users/mike/source/a.go")).toBe("/Users/mike");
    expect(toTildePath("/Users/mike/source/a.go")).toBe("~/source/a.go");
  });

  it("Linux /home/<u> 同样替换", () => {
    expect(toTildePath("/home/bob/x/y.ts")).toBe("~/x/y.ts");
  });

  it("home 之外的路径原样返回", () => {
    expect(guessHome("/opt/data/a.txt")).toBeNull();
    expect(toTildePath("/opt/data/a.txt")).toBe("/opt/data/a.txt");
  });
});

describe("buildContextSnippet", () => {
  it("精确拼装：来源行 + 三反引号围栏 + 尾换行", () => {
    const s = buildContextSnippet("/Users/mike/source/duoxieyun/dxy-gsp-verify/dxy-gsp-verify.go", 'log.GLog.Info("Init cache service")');
    expect(s).toBe(
      "（来自 ~/source/duoxieyun/dxy-gsp-verify/dxy-gsp-verify.go 的片段）\n```\nlog.GLog.Info(\"Init cache service\")\n```\n",
    );
  });

  it("无路径时退化为「选中的片段」", () => {
    expect(buildContextSnippet(undefined, "x")).toBe("（选中的片段）\n```\nx\n```\n");
  });

  it("多行选区原样进围栏", () => {
    expect(buildContextSnippet(undefined, "a\nb")).toContain("```\na\nb\n```");
  });
});

describe("wrapBracketedPaste", () => {
  it("前后缀为 ESC[200~ / ESC[201~", () => {
    expect(wrapBracketedPaste("hi")).toBe("\x1b[200~hi\x1b[201~");
  });
});

describe("shellQuotePath", () => {
  it("纯安全字符的路径原样返回", () => {
    expect(shellQuotePath("/Users/mike/a-b.c_d/file.ts")).toBe("/Users/mike/a-b.c_d/file.ts");
    expect(shellQuotePath("~/x/y+z@v1.0%2,=")).toBe("~/x/y+z@v1.0%2,=");
  });

  it("含空格的路径整体单引号包裹", () => {
    expect(shellQuotePath("/Users/mike/My Docs/a.txt")).toBe("'/Users/mike/My Docs/a.txt'");
  });

  it("含单引号的路径按 POSIX 规则转义", () => {
    expect(shellQuotePath("/tmp/it's.txt")).toBe("'/tmp/it'\\''s.txt'");
  });

  it("含 $ 反引号等 shell 元字符也会包裹", () => {
    expect(shellQuotePath("/tmp/$a`b.txt")).toBe("'/tmp/$a`b.txt'");
  });
});
