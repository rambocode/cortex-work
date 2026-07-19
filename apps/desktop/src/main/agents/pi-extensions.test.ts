// pi-extensions.ts 渲染纯函数 + 落盘的单测。electron(app.getPath) + fs 全 mock。
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ writeFileSync: vi.fn(), mkdirSync: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => "/userData" } }));
vi.mock("fs", () => ({ writeFileSync: h.writeFileSync, mkdirSync: h.mkdirSync }));

import {
  DEFAULT_APPROVAL_TOOLS,
  evaluatePathJail,
  normalizePiTodos,
  renderApprovalExtension,
  renderAskQuestionExtension,
  renderCustomToolExtension,
  renderPathJailExtension,
  renderSlashCommandExtension,
  renderTodoExtension,
  TODO_TOOL_NAME,
  writeApprovalExtension,
  writeAskQuestionExtension,
  writePathJailExtension,
  writeTodoExtension,
} from "./pi-extensions";
import { isAbsolute, join, resolve, sep } from "node:path";

// evaluatePathJail 的真实依赖(node:path)+ 固定 home/cwd/roots,用于直接单测判定逻辑(与内联进 extension 同源)。
const DEPS = { resolve, isAbsolute, join, sep };
const HOME = "/Users/mike";
const CWD = "/Users/mike/proj";
const ROOTS = [CWD, "/skills/foo"];
const jail = (toolName: string, input: Record<string, unknown>) =>
  evaluatePathJail(DEPS, toolName, input, CWD, ROOTS, HOME);

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

describe("evaluatePathJail（目录执行权限「仅工作目录」:读不限、写受限）", () => {
  describe("写型文件工具(write/edit)", () => {
    it("工作目录内的绝对/相对路径 → 放行(null)", () => {
      expect(jail("write", { path: "/Users/mike/proj/a.txt" })).toBeNull();
      expect(jail("edit", { path: "sub/dir/a.ts" })).toBeNull(); // 相对 → resolve 进 cwd
      expect(jail("write", { path: "." })).toBeNull();
    });
    it("已启用 skill 目录内 → 放行", () => {
      expect(jail("write", { path: "/skills/foo/outputs/x.md" })).toBeNull();
    });
    it("工作目录外的写入 → 拦截,文案说明「写入」受限", () => {
      expect(jail("write", { path: "/Users/mike/Desktop/a.txt" })?.reason).toContain("写入");
      expect(jail("edit", { path: "/etc/hosts" })).not.toBeNull();
    });
    it("~ / ~/… 展开成 home 后判界(裸 resolve 不展开 → 误放行的回归)", () => {
      expect(jail("write", { path: "~/Desktop/a.txt" })).not.toBeNull(); // home 外 cwd → 拦
      expect(jail("edit", { path: "~" })).not.toBeNull();
    });
    it("strip 前缀 @(pi file-mention 语法)后再判界", () => {
      expect(jail("write", { path: "@/Users/mike/proj/a.txt" })).toBeNull();
      expect(jail("write", { path: "@/Users/mike/Desktop/a.txt" })).not.toBeNull();
    });
    it("相对路径 .. 逃逸出工作目录 → 拦截", () => {
      expect(jail("write", { path: "../secret.txt" })).not.toBeNull();
    });
    it("缺省 path(undefined/空)→ 工具落 cwd,放行", () => {
      expect(jail("write", {})).toBeNull();
      expect(jail("edit", { path: "" })).toBeNull();
    });
    it("前缀判定带 sep:/Users/mike/proj-evil 不被误判为 /Users/mike/proj 子路径", () => {
      expect(jail("write", { path: "/Users/mike/proj-evil/x" })).not.toBeNull();
    });
  });

  describe("读型文件工具(read/ls/grep/find):读取不受限", () => {
    it("工作目录外/全盘读取 → 一律放行", () => {
      expect(jail("read", { path: "/Users/mike/Desktop/a.txt" })).toBeNull();
      expect(jail("ls", { path: "~/Desktop" })).toBeNull();
      expect(jail("grep", { path: "/etc" })).toBeNull();
      expect(jail("find", { path: "../secret" })).toBeNull();
      expect(jail("read", { path: "/Users/mike/work/team/周报/x.xlsx" })).toBeNull();
    });
  });

  describe("bash(写型命令启发式:读放行、疑似写才判界)", () => {
    it("读型命令引用工作目录外 → 放行(读取不受限)", () => {
      expect(jail("bash", { command: "ls ~/Desktop" })).toBeNull();
      expect(jail("bash", { command: "cat $HOME/Desktop/a.txt" })).toBeNull();
      expect(jail("bash", { command: "grep foo /Users/mike/Desktop/a.txt" })).toBeNull();
      expect(jail("bash", { command: "cat ~/Desktop/a.txt 2>&1" })).toBeNull(); // fd 复制不算写
      expect(jail("bash", { command: "cat ~/Desktop/a.txt 2>/dev/null" })).toBeNull(); // /dev/null 不算写
    });
    it("写型命令涉及工作目录外引用 → 拦截", () => {
      expect(jail("bash", { command: "rm ~/Desktop/a.txt" })).not.toBeNull();
      expect(jail("bash", { command: "mv /Users/mike/Desktop/a b" })).not.toBeNull();
      expect(jail("bash", { command: "echo hi > ~/Desktop/out.txt" })).not.toBeNull(); // 重定向到文件
      expect(jail("bash", { command: "sed -i '' s/a/b/ $HOME/Desktop/a.txt" })).not.toBeNull(); // 原地写
      expect(jail("bash", { command: "tee ${HOME}/Desktop/log" })).not.toBeNull();
    });
    it("写型命令但引用都在工作目录内(或无家目录引用)→ 放行", () => {
      expect(jail("bash", { command: "npm test" })).toBeNull();
      expect(jail("bash", { command: "rm ~/proj/tmp.txt" })).toBeNull(); // ~/proj == cwd
      expect(jail("bash", { command: "echo hi > out.txt" })).toBeNull(); // 相对路径落 cwd
    });
  });

  it("非文件/非 bash 工具 → 不干预(null)", () => {
    expect(jail("browser_navigate", { path: "/Users/mike/Desktop" })).toBeNull();
  });
});

describe("renderPathJailExtension / writePathJailExtension", () => {
  it("内联同源纯函数 + 注入 node:path/os 依赖 + ROOTS;产物自包含(无 __name 等 bundler helper 残留)", () => {
    const src = renderPathJailExtension(["/work/proj", "/skills/foo"]);
    expect(src).toContain('import { homedir } from "node:os"');
    expect(src).toContain("export default function (pi)");
    expect(src).toContain('pi.on("tool_call"');
    expect(src).toContain("const evaluatePathJail =");
    expect(src).toContain('evaluatePathJail({ resolve, isAbsolute, join, sep }, event.toolName, event.input, ctx.cwd, ROOTS, homedir())');
    expect(src).toContain(`const ROOTS = ${JSON.stringify(["/work/proj", "/skills/foo"])};`);
    // 不变量:.toString() 内联后必须自包含 —— 不得引用 esbuild keepNames 的 __name helper(否则 extension 运行即崩)。
    expect(src).not.toContain("__name");
  });

  it("写文件:落 userData/pi-extensions/path-jail.js,mode 0600", () => {
    const path = writePathJailExtension(["/work/proj"]);
    expect(path.endsWith("path-jail.js")).toBe(true);
    expect(h.writeFileSync).toHaveBeenCalledWith(expect.stringContaining("path-jail.js"), expect.any(String), {
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
