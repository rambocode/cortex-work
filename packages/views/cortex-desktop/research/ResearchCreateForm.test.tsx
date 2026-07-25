import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MODE_BUDGETS } from "@cortex-work/core/research/budget";
import type {
  ResearchRequest,
  ResearchSessionSummary,
} from "@cortex-work/core/research/types";
import type { ResearchBridgeLike } from "./bridge-like";
import { ResearchCreateForm } from "./ResearchCreateForm";
import { makeSummary } from "./testFixtures";

afterEach(() => cleanup());

/// 手写 bridge 替身：记录 create / run 的调用参数，其余方法给最小实现。
function makeBridge() {
  const createCalls: ResearchRequest[] = [];
  const runCalls: string[] = [];
  const bridge: ResearchBridgeLike = {
    async create(request) {
      createCalls.push(request);
      return makeSummary({ sessionId: "new-1", objective: request.objective });
    },
    async rerun(): Promise<never> {
      throw new Error("本用例不该重跑");
    },
    async run(sessionId) {
      runCalls.push(sessionId);
    },
    async pause() {},
    async resume() {},
    async cancel() {},
    async get() {
      throw new Error("不应被调用");
    },
    async list() {
      return [];
    },
    async delete() {},
    onEvent() {
      return () => {};
    },
  };
  return { bridge, createCalls, runCalls };
}

describe("ResearchCreateForm", () => {
  it("三档模式都展示 core MODE_BUDGETS 的预算摘要（不自己另写数字）", () => {
    const { bridge } = makeBridge();
    render(<ResearchCreateForm bridge={bridge} onCreated={() => {}} onCancel={() => {}} />);
    for (const mode of ["quick", "standard", "deep"] as const) {
      const budget = MODE_BUDGETS[mode];
      expect(
        screen.getByText(
          `最多 ${budget.maxRounds} 轮 · ${budget.maxDocuments} 篇文档 · ${Math.round(budget.maxDurationMs / 60000)} 分钟`,
        ),
      ).toBeTruthy();
    }
  });

  it("objective 为空时提交按钮禁用", () => {
    const { bridge } = makeBridge();
    render(<ResearchCreateForm bridge={bridge} onCreated={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: "开始研究" })).toBeDisabled();
  });

  it("提交：按选择组装 ResearchRequest → create → run → onCreated", async () => {
    const { bridge, createCalls, runCalls } = makeBridge();
    const created: ResearchSessionSummary[] = [];
    render(
      <ResearchCreateForm bridge={bridge} onCreated={(s) => created.push(s)} onCancel={() => {}} />,
    );

    fireEvent.change(screen.getByLabelText("研究目标"), {
      target: { value: "调查 SQLite WAL 的写放大" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /深度/ }));
    fireEvent.click(screen.getByRole("radio", { name: /允许证据出站/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /个人记忆/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始研究" }));

    await waitFor(() => expect(createCalls).toHaveLength(1));
    const request = createCalls[0]!;
    expect(request.objective).toBe("调查 SQLite WAL 的写放大");
    expect(request.mode).toBe("deep");
    expect(request.modelDataPolicy).toBe("evidence_allowed");
    expect(request.sourceScopes).toEqual([{ kind: "public_web" }, { kind: "memory" }]);
    expect(request.output).toEqual({ format: "report", requireCitations: true });
    expect(runCalls).toEqual(["new-1"]);
    expect(created.map((s) => s.sessionId)).toEqual(["new-1"]);
  });

  it("至少要勾选一个来源范围，全不选时提交禁用", () => {
    const { bridge } = makeBridge();
    render(<ResearchCreateForm bridge={bridge} onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("研究目标"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "公开网页" }));
    expect(screen.getByRole("button", { name: "开始研究" })).toBeDisabled();
  });

  it("create 失败时展示错误且不调用 run", async () => {
    const { bridge, runCalls } = makeBridge();
    const failing: ResearchBridgeLike = {
      ...bridge,
      async create() {
        throw new Error("模型未配置");
      },
    };
    render(<ResearchCreateForm bridge={failing} onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("研究目标"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "开始研究" }));
    expect(await screen.findByText("创建失败：模型未配置")).toBeTruthy();
    expect(runCalls).toEqual([]);
  });

  it("切换策略时展示对应的出站告知", () => {
    const { bridge } = makeBridge();
    render(<ResearchCreateForm bridge={bridge} onCreated={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/云端模型只会收到标题、摘要、域名与统计等元数据/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /仅本地模型/ }));
    expect(screen.getByText(/证据正文与元数据都不会离开这台设备/)).toBeTruthy();
  });
});

describe("ResearchCreateForm 的来源范围与 IPC schema 对齐", () => {
  // 背景（这是一条真实踩过的链路缺陷）：main 的 ipc/research.ts 里
  // sourceScopeSchema 是 discriminatedUnion("kind", [public_web, memory]) 且整个请求 .strict()，
  // local_file 会被直接拒绝——因为它带 roots（本地路径），而 renderer 不得指挥主进程读哪些目录。
  // 表单一旦允许勾选 local_file，用户点「开始研究」就会拿到一条 zod 报错。
  // 因此在 U9 的目录授权流程落地前，这个选项必须是**禁用**的，而不是能勾却提交失败。
  it("本地文件在 M1 不可勾选（IPC 层会拒绝带路径的来源）", () => {
    const { bridge } = makeBridge();
    render(<ResearchCreateForm bridge={bridge} onCreated={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("checkbox", { name: /本地文件/ })).toBeDisabled();
  });

  it("提交的 sourceScopes 只含 IPC schema 认得的 kind", async () => {
    const { bridge, createCalls } = makeBridge();
    render(<ResearchCreateForm bridge={bridge} onCreated={() => {}} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText("研究目标"), { target: { value: "x" } });
    // 即便强行点它也不该进请求（disabled 的 checkbox 不响应，这里再断言一次结果）。
    fireEvent.click(screen.getByRole("checkbox", { name: /本地文件/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /个人记忆/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始研究" }));

    await waitFor(() => expect(createCalls).toHaveLength(1));
    const kinds = createCalls[0]!.sourceScopes.map((scope) => scope.kind);
    expect(kinds).not.toContain("local_file");
    expect(new Set(kinds)).toEqual(new Set(["public_web", "memory"]));
  });
});

describe("默认出站策略来自设置", () => {
  /// 真实踩过：表单把 metadata_only 写死成默认值，无视设置页的「默认数据出站策略」。
  /// 后果隐蔽得多——metadata_only 下模型**从来看不到正文**，只拿到标题与域名，
  /// 于是报告变成「根据标题字面含义推测」，用户看到的是「报告和研究对象没关系」，
  /// 而根本不知道自己（以为）设的那档策略压根没生效。
  it("有 defaultModelDataPolicy 时用它，而不是硬编码的 metadata_only", () => {
    const { bridge } = makeBridge();
    render(
      <ResearchCreateForm
        bridge={bridge}
        defaultModelDataPolicy="evidence_allowed"
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );
    expect((screen.getByRole("radio", { name: /允许证据出站/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("没传时退回 metadata_only（最不容易让用户后悔的那档）", () => {
    const { bridge } = makeBridge();
    render(<ResearchCreateForm bridge={bridge} onCreated={() => {}} onCancel={() => {}} />);
    expect((screen.getByRole("radio", { name: /仅元数据出站/ }) as HTMLInputElement).checked).toBe(true);
  });
})
