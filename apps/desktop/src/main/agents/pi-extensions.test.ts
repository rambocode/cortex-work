// pi-extensions.ts 渲染纯函数 + 落盘的单测。electron(app.getPath) + fs 全 mock。
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ writeFileSync: vi.fn(), mkdirSync: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => "/userData" } }));
vi.mock("fs", () => ({ writeFileSync: h.writeFileSync, mkdirSync: h.mkdirSync }));

import {
  DEFAULT_APPROVAL_TOOLS,
  normalizePiTodos,
  renderApprovalExtension,
  renderAskQuestionExtension,
  renderCustomToolExtension,
  renderSlashCommandExtension,
  renderTodoExtension,
  TODO_TOOL_NAME,
  writeApprovalExtension,
  writeAskQuestionExtension,
  writeTodoExtension,
} from "./pi-extensions";

describe("renderApprovalExtension（阶段3 U7）", () => {
  it("拦 tool_call → ctx.ui.confirm → block 的审批结构", () => {
    const src = renderApprovalExtension();
    expect(src).toContain("export default function (pi)");
    expect(src).toContain('pi.on("tool_call"');
    expect(src).toContain("ctx.hasUI"); // 无 UI 放行
    expect(src).toContain("ctx.ui.confirm");
    expect(src).toContain("block: true");
    expect(src).toContain(JSON.stringify(DEFAULT_APPROVAL_TOOLS)); // 默认审批工具集
  });

  it("自定义审批工具集注入 NEEDS 集合", () => {
    const src = renderApprovalExtension(["bash"]);
    expect(src).toContain('const NEEDS = new Set(["bash"]);');
  });

  it("空数组 → 空 NEEDS 集（不审批任何工具,而非兜回默认三件）", () => {
    const src = renderApprovalExtension([]);
    expect(src).toContain("const NEEDS = new Set([]);");
  });

  it("无参（undefined）→ 默认三件 bash/write/edit", () => {
    const src = renderApprovalExtension();
    expect(src).toContain(`const NEEDS = new Set(${JSON.stringify(DEFAULT_APPROVAL_TOOLS)});`);
  });

  it("写文件:落 userData/pi-extensions/approval.js,mode 0600", () => {
    const path = writeApprovalExtension();
    expect(path).toContain("pi-extensions");
    expect(path.endsWith("approval.js")).toBe(true);
    expect(h.writeFileSync).toHaveBeenCalledWith(expect.stringContaining("approval.js"), expect.any(String), {
      mode: 0o600,
    });
  });
});

describe("renderCustomToolExtension（阶段3 U8）", () => {
  it("registerTool + execute + 普通对象 parameters,无 typebox import", () => {
    const src = renderCustomToolExtension();
    expect(src).toContain("pi.registerTool");
    expect(src).toContain('name: "echo_upper"');
    expect(src).toContain("async execute(");
    expect(src).toContain('parameters: { type: "object"');
    expect(src).not.toContain("import"); // 零 import（spike 已证无需 typebox）
    expect(src).not.toContain("typebox");
  });
});

describe("renderSlashCommandExtension（阶段3 U9）", () => {
  it("registerCommand greet + handler", () => {
    const src = renderSlashCommandExtension();
    expect(src).toContain('pi.registerCommand("greet"');
    expect(src).toContain("handler:");
    expect(src).toContain("ctx.ui.notify");
  });
});

describe("renderAskQuestionExtension（askquestion 工具）", () => {
  it("registerTool askquestion + execute + 借 ctx.ui.input(sentinel),无 import/typebox", () => {
    const src = renderAskQuestionExtension("@@SENT@@");
    expect(src).toContain("pi.registerTool");
    expect(src).toContain('name: "askquestion"');
    expect(src).toContain("async execute(");
    expect(src).toContain("ctx.ui.input(SENTINEL +");
    expect(src).toContain('const SENTINEL = "@@SENT@@";');
    expect(src).toContain("parameters: PARAMS");
    expect(src).not.toContain("import");
    expect(src).not.toContain("typebox");
  });

  it("execute 处理取消:value === undefined → 合法 result(不崩)", () => {
    const src = renderAskQuestionExtension("@@SENT@@");
    expect(src).toContain("value === undefined");
    expect(src).toContain("用户取消了提问");
  });

  it("答案汇总逐组携带问题原文(问/答),非仅 value", () => {
    const src = renderAskQuestionExtension("@@SENT@@");
    expect(src).toContain("qById[g.id] = g.question");
    expect(src).toContain('"问: "');
  });

  it("组数超上限 → execute 给 isError 反馈(而非交给 host 退化成静默取消)", () => {
    const src = renderAskQuestionExtension("@@SENT@@");
    expect(src).toContain("raw.length > 12");
    expect(src).toContain("问题组过多");
  });

  it("写文件:落 userData/pi-extensions/askquestion.js,mode 0600", () => {
    const path = writeAskQuestionExtension("@@SENT@@");
    expect(path.endsWith("askquestion.js")).toBe(true);
    expect(h.writeFileSync).toHaveBeenCalledWith(expect.stringContaining("askquestion.js"), expect.any(String), {
      mode: 0o600,
    });
  });
});

describe("renderTodoExtension（任务清单工具 todo_write）", () => {
  it("registerTool 结构:工具名与 TODO_TOOL_NAME 同源,schema 含三态 status 枚举与 todos 必填", () => {
    const src = renderTodoExtension();
    expect(src).toContain("export default function (pi)");
    expect(src).toContain("pi.registerTool({");
    expect(src).toContain(JSON.stringify(TODO_TOOL_NAME));
    expect(src).toContain('"enum":["pending","in_progress","completed"]');
    expect(src).toContain('"required":["todos"]');
    // 复杂度判断交给模型:description 必须带「复杂多步任务才用」的约束。
    expect(src).toContain("复杂多步任务");
    expect(src).toContain("整表覆盖");
  });

  it("写文件:落 userData/pi-extensions/todo.js,mode 0600", () => {
    const path = writeTodoExtension();
    expect(path.endsWith("todo.js")).toBe(true);
    expect(h.writeFileSync).toHaveBeenCalledWith(expect.stringContaining("todo.js"), expect.any(String), {
      mode: 0o600,
    });
  });
});

describe("normalizePiTodos（todo_write 参数归一化）", () => {
  it("合法项透传;未知状态回退 pending;非法项/空文本跳过", () => {
    expect(
      normalizePiTodos({
        todos: [
          { text: "分析", status: "completed" },
          { text: "实现", status: "in_progress" },
          { text: "验证", status: "bogus" },
          { text: "", status: "pending" },
          "not-an-object",
        ],
      }),
    ).toEqual([
      { text: "分析", status: "completed" },
      { text: "实现", status: "in_progress" },
      { text: "验证", status: "pending" },
    ]);
  });

  it("args 缺失/非数组 → 空数组", () => {
    expect(normalizePiTodos(undefined)).toEqual([]);
    expect(normalizePiTodos({})).toEqual([]);
    expect(normalizePiTodos({ todos: "x" })).toEqual([]);
  });
});
