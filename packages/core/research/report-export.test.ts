// report-export.ts 的测试。
//
// 这个模块的输出会**直接落到用户磁盘上**（项目目录 / Documents 归档），
// 所以测试的重点不是「名字好不好看」，而是「有没有可能写到不该写的地方、
// 或者写出一个操作系统打不开的文件」——路径穿越、Windows 保留名、控制字符
// 这几条都是安全/可用性红线，不是锦上添花。
import { describe, expect, it } from "vitest";

import { researchReportFileBaseName, withResearchHeader } from "./report-export";

const SESSION = { objective: "调研向量数据库选型", sessionId: "ses-abcdef012345" };

describe("researchReportFileBaseName", () => {
  it("正常目标原样当文件名", () => {
    expect(researchReportFileBaseName(SESSION)).toBe("调研向量数据库选型");
  });

  it("剔除路径分隔符与 Windows 非法字符", () => {
    const name = researchReportFileBaseName({
      ...SESSION,
      objective: 'a/b\\c:d*e?f"g<h>i|j',
    });
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name).toContain("a");
    expect(name).toContain("j");
  });

  it("剔除换行、制表与 C0 控制字符", () => {
    // 控制字符用 fromCharCode 拼，别往源码里塞裸字节：那种字符在编辑器里是隐形的，
    // 谁改一下都看不出来测试已经不测原来那件事了。
    const objective = ["前", "\n", "中", "\t", "后", String.fromCharCode(0x07), "尾"].join("");
    const name = researchReportFileBaseName({ ...SESSION, objective });

    expect([...name].every((ch) => (ch.codePointAt(0) ?? 0) >= 0x20)).toBe(true);
    expect(name).toBe("前 中 后 尾");
  });

  it("折叠连续空白，避免文件名里出现一长串空格", () => {
    const name = researchReportFileBaseName({ ...SESSION, objective: "甲   \t  乙" });
    expect(name).toBe("甲 乙");
  });

  it("路径穿越目标不会留下任何分隔符或前导点", () => {
    const name = researchReportFileBaseName({ ...SESSION, objective: "../../etc/passwd" });
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    expect(name.startsWith(".")).toBe(false);
    expect(name).toBe("etc passwd");
  });

  it("去掉首尾的点号与空格（尾点在 Windows 上会被静默丢弃）", () => {
    expect(researchReportFileBaseName({ ...SESSION, objective: "  ..报告..  " })).toBe("报告");
  });

  it.each(["CON", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9", "con", "Com1"])(
    "Windows 保留名 %s 加后缀避让",
    (reserved) => {
      const name = researchReportFileBaseName({ ...SESSION, objective: reserved });
      expect(name).not.toBe(reserved);
      expect(name.startsWith(reserved)).toBe(true);
    },
  );

  it("以保留名开头但不是保留名的目标不受影响", () => {
    expect(researchReportFileBaseName({ ...SESSION, objective: "CONSOLE 调研" })).toBe(
      "CONSOLE 调研",
    );
  });

  it("超长目标按 code point 截到 60", () => {
    const name = researchReportFileBaseName({ ...SESSION, objective: "长".repeat(200) });
    expect([...name]).toHaveLength(60);
  });

  it("截断按 code point 而非 UTF-16 code unit，不会劈开代理对", () => {
    // 每个 emoji 占 2 个 UTF-16 code unit：按 code unit 截会切出半个字符（乱码方块）。
    const name = researchReportFileBaseName({ ...SESSION, objective: "🍎".repeat(100) });
    expect([...name]).toHaveLength(60);
    expect(name).not.toContain("�");
    expect(name).toBe("🍎".repeat(60));
  });

  it("刚好 60 个 code point 不截断", () => {
    const objective = "字".repeat(60);
    expect(researchReportFileBaseName({ ...SESSION, objective })).toBe(objective);
  });

  it("截断后暴露出来的尾部空格与点号也要去掉", () => {
    const objective = `${"字".repeat(59)} 尾巴`;
    expect(researchReportFileBaseName({ ...SESSION, objective })).toBe("字".repeat(59));
  });

  it("空目标回落到 sessionId 前 8 位（永远要有个名字）", () => {
    expect(researchReportFileBaseName({ ...SESSION, objective: "   " })).toBe("research-ses-abcd");
  });

  it("纯符号目标（清洗后什么都不剩）也回落 sessionId", () => {
    expect(researchReportFileBaseName({ ...SESSION, objective: '///:*?"<>|' })).toBe(
      "research-ses-abcd",
    );
  });

  it("纯点号目标回落 sessionId（`.` 与 `..` 是目录自身与上级）", () => {
    expect(researchReportFileBaseName({ ...SESSION, objective: ".." })).toBe("research-ses-abcd");
  });

  it("sessionId 不足 8 位时整个用上", () => {
    expect(researchReportFileBaseName({ objective: "", sessionId: "ses-1" })).toBe("research-ses-1");
  });
});

describe("withResearchHeader", () => {
  it("抬头写明来源与会话 ID，正文原样跟在后面", () => {
    const out = withResearchHeader("# 报告", SESSION);
    expect(out).toBe(
      `> 来自 Cortex 深度研究：${SESSION.objective}\n> 会话 ID：${SESSION.sessionId}\n\n# 报告`,
    );
  });

  it("抬头与正文之间留空行，否则 Markdown 会把正文并进引用块", () => {
    expect(withResearchHeader("正文", SESSION)).toContain("\n\n正文");
  });
});
