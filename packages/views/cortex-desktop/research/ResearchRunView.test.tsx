import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ResearchBridgeLike } from "./bridge-like";
import { ResearchRunView } from "./ResearchRunView";
import { makeFullView, makeReport, makeSummary } from "./testFixtures";

afterEach(() => cleanup());

/// 手写 bridge 替身：只记录控制类调用（暂停/恢复/取消）。
function makeBridge() {
  const calls: Array<[string, string]> = [];
  const bridge: ResearchBridgeLike = {
    async create() {
      throw new Error("不应被调用");
    },
    async run(id) {
      calls.push(["run", id]);
    },
    async rerun(id) {
      calls.push(["rerun", id]);
      return makeSummary({ sessionId: `${id}-clone`, status: "created" });
    },
    async pause(id) {
      calls.push(["pause", id]);
    },
    async resume(id) {
      calls.push(["resume", id]);
    },
    async cancel(id) {
      calls.push(["cancel", id]);
    },
    async get() {
      throw new Error("RunView 不应自行拉取详情");
    },
    async list() {
      return [];
    },
    async delete() {},
    onEvent() {
      return () => {};
    },
  };
  return { bridge, calls };
}

describe("ResearchRunView 空态", () => {
  it("未选中会话时提示去左栏选择", () => {
    const { bridge } = makeBridge();
    render(<ResearchRunView bridge={bridge} session={null} />);
    expect(screen.getByText("在左侧选择一个研究，或新建一个")).toBeTruthy();
  });
});

describe("ResearchRunView 操作按钮可用性（由 status 决定）", () => {
  it("终态（completed）：暂停 / 取消 / 恢复 全部禁用", () => {
    const { bridge } = makeBridge();
    render(<ResearchRunView bridge={bridge} session={makeSummary({ status: "completed" })} />);
    expect(screen.getByRole("button", { name: "暂停" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "恢复" })).toBeDisabled();
  });

  /// 回归：新建会话时的自动 run 若失败（例如当时还没配好搜索服务），会话会停在 created。
  /// 这时暂停/恢复都不适用，若再没有「开始」，这个会话就只能删掉重建——真实踩过一次。
  it("待开始（created）：可点「开始」触发 run，暂停 / 恢复不可用", async () => {
    const { bridge, calls } = makeBridge();
    render(
      <ResearchRunView bridge={bridge} session={makeSummary({ sessionId: "s1", status: "created" })} />,
    );
    const start = screen.getByRole("button", { name: "开始" });
    expect(start).not.toBeDisabled();
    fireEvent.click(start);
    await waitFor(() => expect(calls).toEqual([["run", "s1"]]));
    expect(screen.getByRole("button", { name: "暂停" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "恢复" })).toBeDisabled();
  });

  it("非 created 状态下「开始」禁用（避免重复起第二轮编排）", () => {
    const { bridge } = makeBridge();
    render(<ResearchRunView bridge={bridge} session={makeSummary({ status: "searching" })} />);
    expect(screen.getByRole("button", { name: "开始" })).toBeDisabled();
  });

  it("运行中（searching）：可暂停可取消，点击透传 sessionId", async () => {
    const { bridge, calls } = makeBridge();
    render(
      <ResearchRunView bridge={bridge} session={makeSummary({ sessionId: "s9", status: "searching" })} />,
    );
    const cancel = screen.getByRole("button", { name: "取消" });
    expect(cancel).not.toBeDisabled();
    fireEvent.click(cancel);
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      ["cancel", "s9"],
      ["pause", "s9"],
    ]);
    expect(screen.getByRole("button", { name: "恢复" })).toBeDisabled();
  });

  it("已暂停：可恢复，不可暂停", async () => {
    const { bridge, calls } = makeBridge();
    render(
      <ResearchRunView bridge={bridge} session={makeSummary({ sessionId: "s9", status: "paused" })} />,
    );
    expect(screen.getByRole("button", { name: "暂停" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(calls).toEqual([["resume", "s9"]]));
  });

  it("已中断：可恢复（崩溃恢复与暂停恢复共用同一入口）", () => {
    const { bridge } = makeBridge();
    render(<ResearchRunView bridge={bridge} session={makeSummary({ status: "interrupted" })} />);
    expect(screen.getByRole("button", { name: "恢复" })).not.toBeDisabled();
  });

  it("bridge 为 null 时全部控制按钮禁用（Web 端降级）", () => {
    render(<ResearchRunView bridge={null} session={makeSummary({ status: "searching" })} />);
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  });
});

describe("ResearchRunView 内容", () => {
  it("展示计划的子问题与初始查询", () => {
    const { bridge } = makeBridge();
    const view = makeFullView();
    render(<ResearchRunView bridge={bridge} session={view.summary} view={view} />);
    expect(screen.getByText("主流运行时有哪些")).toBeTruthy();
    expect(screen.getByText("rust async runtime 对比")).toBeTruthy();
  });

  it("展示轮次进度与当前阶段", () => {
    const { bridge } = makeBridge();
    const view = makeFullView();
    render(
      <ResearchRunView
        bridge={bridge}
        session={makeSummary({ status: "fetching", roundCount: 2 })}
        view={view}
        progress={{ stage: "fetching", completed: 3, total: 10 }}
      />,
    );
    expect(screen.getByText("抓取 3 / 10")).toBeTruthy();
    expect(screen.getByText("第 1 轮")).toBeTruthy();
  });

  it("失败列表按 FetchFailureCode 给中文说明，未知码有兜底", () => {
    const { bridge } = makeBridge();
    render(
      <ResearchRunView
        bridge={bridge}
        session={makeSummary({ status: "fetching" })}
        warnings={[
          { code: "timeout", message: "https://a.example 超时" },
          { code: "weird_code", message: "https://b.example 未知" },
        ]}
      />,
    );
    expect(screen.getByText("抓取超时")).toBeTruthy();
    expect(screen.getByText("抓取失败（weird_code）")).toBeTruthy();
  });

  it("渲染报告 markdown，并支持导出", async () => {
    const { bridge } = makeBridge();
    const view = makeFullView();
    const exported: string[] = [];
    render(
      <ResearchRunView
        bridge={bridge}
        session={view.summary}
        view={view}
        onExportMarkdown={(md) => exported.push(md)}
      />,
    );
    expect(await screen.findByText("Tokio 是当前最主流的选择。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "导出 Markdown" }));
    expect(exported).toEqual([view.report?.markdown]);
  });

  it("报告里的 [^chunkId] 渲染成编号 chip，并在文末生成参考来源列表", async () => {
    const { bridge } = makeBridge();
    const view = makeFullView({
      report: makeReport({
        markdown: "Tokio 是当前最主流的选择[^ch1]（来源：Tokio 教程）。",
      }),
    });
    render(<ResearchRunView bridge={bridge} session={view.summary} view={view} />);
    // 原始标记与尾随的（来源：…）不再出现在正文里
    expect(screen.queryByText(/\[\^ch1\]/)).toBeNull();
    // 编号 chip 与文末参考来源条目各出现一次 [1]
    expect((await screen.findAllByText("[1]")).length).toBe(2);
    expect(screen.getByText("参考来源（1）")).toBeTruthy();
    expect(screen.getByText("Tokio 教程")).toBeTruthy();
  });

  it("与目标重复的报告 h1 在展示时被剥掉", async () => {
    const { bridge } = makeBridge();
    const view = makeFullView({
      report: makeReport({
        markdown: "# 调查 Rust 异步运行时的现状\n\n## 结论\n\n正文。",
      }),
    });
    render(<ResearchRunView bridge={bridge} session={view.summary} view={view} />);
    expect(await screen.findByText("正文。")).toBeTruthy();
    // 报告区内不再出现与目标同名的 h1（运行视图头部仍有标题，那是 session.objective 本身）
    expect(screen.queryByRole("heading", { name: "调查 Rust 异步运行时的现状" })).toBeNull();
  });

  it("报告里的危险协议链接（javascript: 等）不渲染成可点链接", async () => {
    const { bridge } = makeBridge();
    const view = makeFullView({
      report: makeReport({
        markdown: "详见[这里](javascript:alert(1))。",
      }),
    });
    render(<ResearchRunView bridge={bridge} session={view.summary} view={view} />);
    const link = (await screen.findByText("这里")).closest("a");
    expect(link).toBeTruthy();
    // react-markdown 的 urlTransform 与组件内 isSafeHref 两层防护下，href 绝不允许是 javascript:
    expect(link?.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
  });

  it("无报告时导出按钮禁用", () => {
    const { bridge } = makeBridge();
    render(
      <ResearchRunView
        bridge={bridge}
        session={makeSummary({ status: "searching" })}
        onExportMarkdown={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "导出 Markdown" })).toBeDisabled();
  });
});

describe("ResearchRunView 启动失败提示", () => {
  /// 回归：新建时自动 run 失败的原因（如「尚未配置研究搜索服务」）过去只写在
  /// 创建表单的局部 state 上，而 onCreated 会立刻卸载那个表单 —— 用户只看到一个
  /// 停在「待开始」的会话，完全不知道为什么。原因必须落到会话视图上。
  it("startError 显示在会话视图里", () => {
    const { bridge } = makeBridge();
    render(
      <ResearchRunView
        bridge={bridge}
        session={makeSummary({ status: "created" })}
        startError="启动失败：尚未配置研究搜索服务，请在设置中填写地址与凭据"
      />,
    );
    expect(screen.getByText(/尚未配置研究搜索服务/)).toBeTruthy();
  });

  it("没有 startError 时不渲染多余的错误块", () => {
    const { bridge } = makeBridge();
    const { container } = render(
      <ResearchRunView bridge={bridge} session={makeSummary({ status: "created" })} />,
    );
    expect(container.querySelectorAll(".pw-res-error")).toHaveLength(0);
  });
});


describe("重跑（终态会话的出路）", () => {
  /// 终态在状态机里没有出口，此前用户只能删掉重建——而删掉会连报告一起没。
  /// 重跑是**新建一个会话**（旧的原样保留），所以新会话必须交给宿主去选中，
  /// 组件自己做不到这件事。
  it("已完成时可点重跑，并把新会话交给宿主", async () => {
    const { bridge, calls } = makeBridge();
    const created: string[] = [];
    render(
      <ResearchRunView
        bridge={bridge}
        session={makeSummary({ sessionId: "s1", status: "completed" })}
        onRerun={(s) => created.push(s.sessionId)}
      />,
    );
    const btn = screen.getByRole("button", { name: "重跑" });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() => expect(calls).toEqual([["rerun", "s1"]]));
    await waitFor(() => expect(created).toEqual(["s1-clone"]));
  });

  it("非终态时重跑禁用", () => {
    const { bridge } = makeBridge();
    render(
      <ResearchRunView
        bridge={bridge}
        session={makeSummary({ status: "searching" })}
        onRerun={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "重跑" })).toBeDisabled();
  });

  /// 宿主没接管 onRerun 时禁用：否则用户点完「什么都没发生」，
  /// 而后台其实已经建了一个孤儿会话。
  it("宿主未提供 onRerun 时禁用（避免建出没人选中的孤儿会话）", () => {
    const { bridge } = makeBridge();
    render(<ResearchRunView bridge={bridge} session={makeSummary({ status: "completed" })} />);
    expect(screen.getByRole("button", { name: "重跑" })).toBeDisabled();
  });
});
