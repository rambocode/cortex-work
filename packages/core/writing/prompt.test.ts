// composeWritingPrompt / quoteFromSelection / 反解析 单测(U8):
// 拼装含/不含引用、含当前文件相对路径;改稿约定恒在;引用快照冻结;哨兵反解析对称。
import { describe, expect, it } from "vitest";
import {
  WRITING_CONTEXT_HEADING,
  WRITING_QUOTE_HEADING,
  WRITING_RETRIEVAL_HEADING,
  WRITING_REVISION_HEADING,
  WRITING_WEB_HEADING,
  WRITING_REVISION_RULE,
  composeWritingPrompt,
  formatWritingRetrievalForPrompt,
  formatWritingWebEvidenceForPrompt,
  parseWritingPromptForDisplay,
  quoteFromSelection,
  relativeWritingPath,
  type WritingQuote,
} from "./prompt";
import type { WritingRetrievalContext } from "../desktop/writing-retrieval-types";
import type { PreparedDocument } from "../research/quick-types";

// 构造一个含单条文本片段的检索上下文(U4)。
function makeRetrieval(): WritingRetrievalContext {
  return {
    source: "bm25-keyword",
    query: "光合作用",
    keywords: ["光合作用", "叶绿素"],
    snippets: [
      {
        path: "notes/bio.md",
        title: "光合作用",
        text: "光合作用把光能转化为化学能。\n\n叶绿素在其中吸收光。",
        score: 1.23,
        keywords: ["光合作用"],
        location: { kind: "text", lineStart: 3, lineEnd: 6 },
      },
    ],
    indexedFiles: 1,
    indexedChunks: 2,
  };
}

const ROOT = "/space";
const FILE = "/space/sub/a.md";

describe("relativeWritingPath", () => {
  it("命中根前缀截相对路径,否则回落 basename", () => {
    expect(relativeWritingPath(ROOT, FILE)).toBe("sub/a.md");
    expect(relativeWritingPath(ROOT, "/other/b.md")).toBe("b.md");
    // 反斜杠归一化
    expect(relativeWritingPath("C:\\space", "C:\\space\\c.md")).toBe("c.md");
  });
});

describe("composeWritingPrompt", () => {
  it("不含引用:上下文(当前文件)+ 改稿约定 + 用户正文", () => {
    const out = composeWritingPrompt("帮我改改", [], { workspaceRoot: ROOT, activeFilePath: FILE });
    expect(out).toContain(`${WRITING_CONTEXT_HEADING}\n当前文件: sub/a.md`);
    expect(out).toContain(`${WRITING_REVISION_HEADING}\n${WRITING_REVISION_RULE}`);
    expect(out.trimEnd().endsWith("帮我改改")).toBe(true);
    // 无引用时不出现引用哨兵
    expect(out).not.toContain(WRITING_QUOTE_HEADING);
  });

  it("含引用:引用片段块携带行号/字数/路径与原文", () => {
    const quote: WritingQuote = {
      id: "q1",
      text: "被引用的原文",
      sourceTitle: "sub/a.md",
      sourceFilePath: FILE,
      lineStart: 3,
      lineEnd: 5,
      charCount: 6,
      createdAt: 0,
    };
    const out = composeWritingPrompt("润色这段", [quote], { workspaceRoot: ROOT, activeFilePath: FILE });
    expect(out).toContain(`${WRITING_QUOTE_HEADING} sub/a.md（第3-5行，共6字）路径: ${FILE}`);
    expect(out).toContain("[引用原文]\n被引用的原文\n[/引用原文]");
    expect(out).toContain("润色这段");
  });

  it("改稿约定恒在:即便无正文无引用也带约定", () => {
    const out = composeWritingPrompt("", [], {});
    expect(out).toContain(WRITING_REVISION_RULE);
  });

  it("无当前文件时省略上下文块,仍有改稿约定与正文", () => {
    const out = composeWritingPrompt("写点东西", [], {});
    expect(out).not.toContain(WRITING_CONTEXT_HEADING);
    expect(out).toContain(WRITING_REVISION_RULE);
    expect(out.trimEnd().endsWith("写点东西")).toBe(true);
  });
});

describe("quoteFromSelection", () => {
  it("从选区快照构造冻结引用(相对标题 + 行号 + 字数)", () => {
    const q = quoteFromSelection(
      { text: "  选中文本  ", charCount: 4, lineStart: 2, lineEnd: 2 },
      FILE,
      ROOT,
      1000,
    );
    expect(q).not.toBeNull();
    expect(q!.text).toBe("选中文本"); // trim
    expect(q!.sourceTitle).toBe("sub/a.md");
    expect(q!.sourceFilePath).toBe(FILE);
    expect(q!.lineStart).toBe(2);
    expect(q!.charCount).toBe(4);
  });

  it("空选区返回 null", () => {
    expect(quoteFromSelection({ text: "   ", charCount: 0 }, FILE, ROOT)).toBeNull();
  });

  // PDF 选区(U5):sourceKind=pdf + 页码定位,quote 冻结来源类型与页码。
  it("从 PDF 选区快照构造引用(sourceKind=pdf + 页码)", () => {
    const q = quoteFromSelection(
      { text: "PDF 里选中的一段", charCount: 8, sourceKind: "pdf", pageStart: 3, pageEnd: 4 },
      "/space/docs/paper.pdf",
      ROOT,
      2000,
    );
    expect(q).not.toBeNull();
    expect(q!.sourceKind).toBe("pdf");
    expect(q!.pageStart).toBe(3);
    expect(q!.pageEnd).toBe(4);
    expect(q!.lineStart).toBeUndefined();
    expect(q!.sourceTitle).toBe("docs/paper.pdf");
  });
});

describe("PDF 引用(U5)prompt 拼装与反解析", () => {
  const PDF = "/space/docs/paper.pdf";

  it("跨页引用:prompt 段标「第x-y页」而非行号", () => {
    const quote: WritingQuote = {
      id: "q1",
      text: "跨页原文",
      sourceTitle: "docs/paper.pdf",
      sourceFilePath: PDF,
      sourceKind: "pdf",
      pageStart: 3,
      pageEnd: 4,
      charCount: 4,
      createdAt: 0,
    };
    const out = composeWritingPrompt("总结这段", [quote], { workspaceRoot: ROOT, activeFilePath: FILE });
    expect(out).toContain(`${WRITING_QUOTE_HEADING} docs/paper.pdf（第3-4页，共4字）路径: ${PDF}`);
  });

  it("单页引用:标「第x页」;反解析回页码 + sourceKind=pdf", () => {
    const quote: WritingQuote = {
      id: "q2",
      text: "单页原文",
      sourceTitle: "docs/paper.pdf",
      sourceFilePath: PDF,
      sourceKind: "pdf",
      pageStart: 5,
      pageEnd: 5,
      charCount: 4,
      createdAt: 0,
    };
    const out = composeWritingPrompt("解释", [quote], { workspaceRoot: ROOT, activeFilePath: FILE });
    expect(out).toContain("（第5页，共4字）");
    const display = parseWritingPromptForDisplay(out);
    expect(display).not.toBeNull();
    const dq = display!.quotes[0]!;
    expect(dq.sourceKind).toBe("pdf");
    expect(dq.pageStart).toBe(5);
    expect(dq.pageEnd).toBe(5);
    expect(dq.lineStart).toBeUndefined();
  });
});

describe("parseWritingPromptForDisplay(哨兵反解析)", () => {
  it("反解析回用户正文 + 当前文件 + 引用,丢弃改稿约定", () => {
    const quote: WritingQuote = {
      id: "q1",
      text: "原文片段",
      sourceTitle: "sub/a.md",
      sourceFilePath: FILE,
      lineStart: 1,
      lineEnd: 2,
      charCount: 4,
      createdAt: 0,
    };
    const prompt = composeWritingPrompt("请改这里", [quote], {
      workspaceRoot: ROOT,
      activeFilePath: FILE,
    });
    const display = parseWritingPromptForDisplay(prompt);
    expect(display).not.toBeNull();
    expect(display!.userInput).toBe("请改这里");
    expect(display!.activeFile).toBe("sub/a.md");
    expect(display!.quotes).toHaveLength(1);
    expect(display!.quotes[0]!.text).toBe("原文片段");
    expect(display!.quotes[0]!.lineStart).toBe(1);
    expect(display!.quotes[0]!.lineEnd).toBe(2);
  });

  it("裸文本(无哨兵)返回 null", () => {
    expect(parseWritingPromptForDisplay("普通一句话")).toBeNull();
  });
});

describe("检索上下文注入(U4)", () => {
  it("无检索(null)→ 不出现检索哨兵(开关关闭/失败降级等价于不注入)", () => {
    const prompt = composeWritingPrompt("请改这里", [], {
      workspaceRoot: ROOT,
      activeFilePath: FILE,
      retrieval: null,
    });
    expect(prompt).not.toContain(WRITING_RETRIEVAL_HEADING);
    // 用户正文与改稿约定仍在。
    expect(prompt).toContain("请改这里");
    expect(prompt).toContain(WRITING_REVISION_HEADING);
  });

  it("空片段列表 → 不注入", () => {
    const empty: WritingRetrievalContext = { ...makeRetrieval(), snippets: [] };
    expect(formatWritingRetrievalForPrompt(empty)).toBe("");
    const prompt = composeWritingPrompt("正文", [], { retrieval: empty });
    expect(prompt).not.toContain(WRITING_RETRIEVAL_HEADING);
  });

  it("有片段 → 注入检索段(含起止哨兵、来源定位与片段正文)", () => {
    const prompt = composeWritingPrompt("请改这里", [], {
      workspaceRoot: ROOT,
      activeFilePath: FILE,
      retrieval: makeRetrieval(),
    });
    expect(prompt).toContain(WRITING_RETRIEVAL_HEADING);
    expect(prompt).toContain("notes/bio.md:3-6"); // 文本档来源定位
    expect(prompt).toContain("光合作用把光能转化为化学能");
  });

  it("展示反解析:整块剥离检索段(含内部空行),不污染用户正文", () => {
    const prompt = composeWritingPrompt("请润色这一段", [], {
      workspaceRoot: ROOT,
      activeFilePath: FILE,
      retrieval: makeRetrieval(),
    });
    const display = parseWritingPromptForDisplay(prompt);
    expect(display).not.toBeNull();
    // 用户正文干净,不含检索片段正文(片段含空行,若剥离不当会并入 userInput)。
    expect(display!.userInput).toBe("请润色这一段");
    expect(display!.userInput).not.toContain("叶绿素");
    expect(display!.activeFile).toBe("sub/a.md");
  });
});

describe("外部网页资料段（写作检索）", () => {
  const doc = (over: Partial<PreparedDocument> = {}): PreparedDocument => ({
    url: "https://a.com/p",
    title: "外部标题",
    text: "网页正文",
    truncated: false,
    fetchMethod: "http",
    ...over,
  });

  it("无资料时整段省略（不留一个空标题）", () => {
    expect(formatWritingWebEvidenceForPrompt([])).toBe("");
    expect(formatWritingWebEvidenceForPrompt(null)).toBe("");
    expect(composeWritingPrompt("正文", [], { webEvidence: [] })).not.toContain(WRITING_WEB_HEADING);
  });

  it("每条都带 URL，并要求标注来源", () => {
    const out = formatWritingWebEvidenceForPrompt([doc()]);
    expect(out).toContain("https://a.com/p");
    expect(out).toContain("外部标题");
    expect(out).toContain("网页正文");
    expect(out).toContain("必须在文中标注来源链接");
  });

  it("标题缺失时用 URL 兜底", () => {
    expect(formatWritingWebEvidenceForPrompt([doc({ title: undefined })])).toContain("[W1] https://a.com/p");
  });

  it("截断的正文标注出来（避免 agent 把节选当全文引用）", () => {
    expect(formatWritingWebEvidenceForPrompt([doc({ truncated: true })])).toContain("正文已截断");
  });

  /// 本地资料是用户自己的东西，冲突时应以它为准——同「手写记忆优先于自动整理」的取舍。
  it("排在本地文献之后、改稿约定之前", () => {
    const composed = composeWritingPrompt("正文", [], {
      retrieval: makeRetrieval(),
      webEvidence: [doc()],
    });
    const localIdx = composed.indexOf(WRITING_RETRIEVAL_HEADING);
    const webIdx = composed.indexOf(WRITING_WEB_HEADING);
    const revisionIdx = composed.indexOf("正文");
    expect(localIdx).toBeGreaterThanOrEqual(0);
    expect(webIdx).toBeGreaterThan(localIdx);
    expect(revisionIdx).toBeGreaterThan(webIdx);
  });

  /// 回归点：只剥本地段的话，网页正文会被按空行切碎并当成用户输入显示在消息气泡里。
  it("展示层反解析把网页资料段整块剥掉，用户正文不被污染", () => {
    const composed = composeWritingPrompt("我写的正文", [], {
      webEvidence: [doc({ text: "网页正文\n\n含空行的第二段" })],
    });
    const display = parseWritingPromptForDisplay(composed);
    expect(display).not.toBeNull();
    expect(display!.userInput).toBe("我写的正文");
    expect(display!.userInput).not.toContain("网页正文");
    expect(display!.userInput).not.toContain("含空行的第二段");
  });

  it("只有网页资料段（无其它哨兵）时也能被识别并剥离", () => {
    const composed = composeWritingPrompt("我写的正文", [], { webEvidence: [doc()] });
    const display = parseWritingPromptForDisplay(composed);
    expect(display?.userInput).toBe("我写的正文");
  });
});
