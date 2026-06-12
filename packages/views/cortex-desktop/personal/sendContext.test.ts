import { describe, expect, it } from "vitest";
import { buildContextSnippet, guessHome, toTildePath, wrapBracketedPaste } from "./sendContext";

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
