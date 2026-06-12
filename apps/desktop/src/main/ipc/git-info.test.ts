import { describe, expect, it } from "vitest";
import { countAddedLines, parseNumstat, parseUntracked, sumStats, synthUntrackedDiff } from "./git-info";

describe("parseNumstat", () => {
  it("解析普通行", () => {
    expect(parseNumstat("12\t3\tsrc/a.ts\n0\t5\tREADME.md\n")).toEqual([
      { add: 12, del: 3, path: "src/a.ts", binary: false },
      { add: 0, del: 5, path: "README.md", binary: false },
    ]);
  });

  it("二进制行(-\\t-)计 0 并标记 binary", () => {
    expect(parseNumstat("-\t-\tlogo.png\n")).toEqual([{ add: 0, del: 0, path: "logo.png", binary: true }]);
  });

  it("空输入返回空数组", () => {
    expect(parseNumstat("")).toEqual([]);
    expect(parseNumstat("\n")).toEqual([]);
  });

  it("路径含 tab 时保留完整路径", () => {
    expect(parseNumstat("1\t2\ta\tb.txt\n")[0].path).toBe("a\tb.txt");
  });
});

describe("parseUntracked", () => {
  it("只取 ?? 行并解引号", () => {
    const out = '?? new.ts\n M changed.ts\nA  staged.ts\n?? "with space.md"\n';
    expect(parseUntracked(out)).toEqual(["new.ts", "with space.md"]);
  });

  it("目录条目(尾部斜杠)跳过", () => {
    expect(parseUntracked("?? newdir/\n?? a.ts\n")).toEqual(["a.ts"]);
  });

  it("空输入返回空数组", () => {
    expect(parseUntracked("")).toEqual([]);
  });
});

describe("countAddedLines", () => {
  it("末尾有换行:行数 = 换行数", () => {
    expect(countAddedLines("a\nb\n")).toBe(2);
  });

  it("末尾无换行:最后一行也算", () => {
    expect(countAddedLines("a\nb")).toBe(2);
    expect(countAddedLines("only")).toBe(1);
  });

  it("空文件 0 行", () => {
    expect(countAddedLines("")).toBe(0);
  });
});

describe("sumStats", () => {
  it("tracked 与 untracked 累加,untracked 全计 additions", () => {
    const tracked = parseNumstat("10\t2\ta.ts\n5\t1\tb.ts\n");
    expect(sumStats(tracked, [7, 3])).toEqual({ additions: 25, deletions: 3 });
  });

  it("二进制 tracked 计 0", () => {
    const tracked = parseNumstat("-\t-\tbin.png\n1\t1\ta.ts\n");
    expect(sumStats(tracked, [])).toEqual({ additions: 1, deletions: 1 });
  });

  it("空输入为 0", () => {
    expect(sumStats([], [])).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("synthUntrackedDiff", () => {
  it("合成含 diff --git / new file / @@ 头与 + 前缀行", () => {
    const diff = synthUntrackedDiff("src/new.ts", "line1\nline2\n");
    expect(diff).toBe(
      "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+line1\n+line2\n",
    );
  });

  it("末行无换行追加 no-newline 标记", () => {
    const diff = synthUntrackedDiff("a.txt", "only");
    expect(diff).toContain("@@ -0,0 +1,1 @@\n+only\n\\ No newline at end of file\n");
  });

  it("空文件只有头无 hunk", () => {
    const diff = synthUntrackedDiff("empty.txt", "");
    expect(diff).not.toContain("@@");
    expect(diff).toContain("new file mode 100644");
  });

  it("二进制(null)输出占位行", () => {
    expect(synthUntrackedDiff("logo.png", null)).toContain("Binary files /dev/null and b/logo.png differ");
  });
});
