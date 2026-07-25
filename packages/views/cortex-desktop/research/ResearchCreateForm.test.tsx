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
    fireEvent.click(screen.getByRole("checkbox", { name: /个人记忆/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始研究" }));

    await waitFor(() => expect(createCalls).toHaveLength(1));
    const request = createCalls[0]!;
    expect(request.objective).toBe("调查 SQLite WAL 的写放大");
    expect(request.mode).toBe("deep");
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

describe("模型告知（只读，不是选择项）", () => {
  /// 「数据发给谁」必须在**动作发生前**可见：这一行在「开始研究」按钮之上，
  /// 用户按下去之前一定看得到。它是只读的——研究用哪个模型在设置里定，
  /// 表单里再给一份选择只会产生两个可以互相矛盾的真源。
  it("远端模型：显示模型名与「会发送」说明", () => {
    const { bridge } = makeBridge();
    const { container } = render(
      <ResearchCreateForm
        bridge={bridge}
        model={{
          label: "DeepSeek / deepseek-chat",
          isLocal: false,
          egressZh: "证据正文片段与元数据会发送给所选的模型供应商。",
        }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(container.textContent).toContain("本次研究将使用：DeepSeek / deepseek-chat");
    expect(container.textContent).toContain("会发送给所选的模型供应商");
    expect(container.querySelector(".pw-res-notice.is-remote")).toBeTruthy();
  });

  it("本机模型：标记为 local，说明数据不离开设备", () => {
    const { bridge } = makeBridge();
    const { container } = render(
      <ResearchCreateForm
        bridge={bridge}
        model={{
          label: "本机 Ollama / qwen3:8b",
          isLocal: true,
          egressZh: "该模型运行在本机：证据正文与元数据都不会离开这台设备。",
        }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(container.textContent).toContain("不会离开这台设备");
    expect(container.querySelector(".pw-res-notice.is-local")).toBeTruthy();
  });

  it("没配可用模型时给出提示而不是空白", () => {
    const { bridge } = makeBridge();
    const { container } = render(
      <ResearchCreateForm
        bridge={bridge}
        model={{ label: null, isLocal: false, egressZh: "尚未配置任何可用的模型供应商。" }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(container.textContent).toContain("尚未配置可用的模型");
  });

  it("宿主没传 model 时整段不渲染（Web 端或旧宿主）", () => {
    const { bridge } = makeBridge();
    const { container } = render(
      <ResearchCreateForm bridge={bridge} onCreated={() => {}} onCancel={() => {}} />,
    );
    expect(container.querySelector(".pw-res-notice")).toBeNull();
  });

  it("表单里不再有出站策略选择项", () => {
    const { bridge } = makeBridge();
    render(<ResearchCreateForm bridge={bridge} onCreated={() => {}} onCancel={() => {}} />);
    expect(screen.queryByText("数据出站策略")).toBeNull();
    expect(screen.queryByRole("radio", { name: /允许证据出站/ })).toBeNull();
  });
})
