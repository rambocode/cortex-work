// AskQuestionCard 富卡片（U5）:读 store piUiPending 中「当前活跃会话」的 askquestion 队首,渲染
// 多组(推荐项 + 自定义互斥),整卡必答后提交聚合 JSON 回写 {value},取消/ESC → {cancelled};会话隔离。

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore, type DesktopBridge, type PiUiRequest } from "@cortex-work/core";
import { AskQuestionCard } from "./AskQuestionCard";

function makeBridge() {
  return {
    loadChat: async () => [],
    saveChat: async () => {},
    piUiResponse: vi.fn(async () => undefined),
  } as unknown as DesktopBridge & { piUiResponse: ReturnType<typeof vi.fn> };
}

function renderCard(bridge: DesktopBridge, sessionId = "s-pi") {
  return render(
    <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
      <AskQuestionCard sessionId={sessionId} />
    </CoreProvider>,
  );
}

const askReq = (id: string, envelope: unknown): PiUiRequest =>
  ({ type: "extension_ui_request", id, method: "askquestion", envelope }) as unknown as PiUiRequest;

const oneGroup = {
  groups: [
    {
      id: "g0",
      question: "选哪个?",
      options: [{ label: "选项A" }, { label: "选项B", description: "B 的说明" }],
      recommended: 0,
      allowCustom: true,
    },
  ],
};

const lastResp = (bridge: ReturnType<typeof makeBridge>) =>
  bridge.piUiResponse.mock.calls[bridge.piUiResponse.mock.calls.length - 1];

beforeEach(() => usePersonalStore.setState({ piUiPending: [] }));
afterEach(() => cleanup());

describe("AskQuestionCard（U5）", () => {
  it("无 pending → 不渲染", () => {
    renderCard(makeBridge());
    expect(screen.queryByRole("group", { name: "向你提问" })).toBeNull();
  });

  it("单组渲染:问题 + 选项 + 推荐 badge", () => {
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: askReq("a1", oneGroup) }] });
    renderCard(makeBridge());
    expect(screen.getByText("选哪个?")).toBeInTheDocument();
    expect(screen.getByText("选项A")).toBeInTheDocument();
    expect(screen.getByText("B 的说明")).toBeInTheDocument();
    expect(screen.getByText("推荐")).toBeInTheDocument();
  });

  it("选推荐项提交 → piUiResponse{value} 含正确答案 + 出队", () => {
    const bridge = makeBridge();
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: askReq("a1", oneGroup) }] });
    renderCard(bridge);
    fireEvent.click(screen.getByText("选项A"));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    const [sid, id, payload] = lastResp(bridge)!;
    expect(sid).toBe("s-pi");
    expect(id).toBe("a1");
    expect(JSON.parse((payload as { value: string }).value)).toEqual({
      answers: [{ groupId: "g0", value: "选项A", isCustom: false }],
    });
    expect(usePersonalStore.getState().piUiPending).toHaveLength(0);
  });

  it("走自定义 → 选项置灰(input 互斥),提交回写 isCustom:true", () => {
    const bridge = makeBridge();
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: askReq("a1", oneGroup) }] });
    renderCard(bridge);
    fireEvent.change(screen.getByPlaceholderText("或自定义回答…"), { target: { value: "我的答案" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(JSON.parse((lastResp(bridge)![2] as { value: string }).value)).toEqual({
      answers: [{ groupId: "g0", value: "我的答案", isCustom: true }],
    });
  });

  it("多组:选完当前组自动跳下一组,tab 显 ✓,补齐后聚合提交", () => {
    const bridge = makeBridge();
    const twoGroups = {
      groups: [
        { id: "g0", question: "Q0", options: [{ label: "A" }], allowCustom: false },
        { id: "g1", question: "Q1", options: [{ label: "X" }, { label: "Y" }], allowCustom: false },
      ],
    };
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: askReq("a1", twoGroups) }] });
    renderCard(bridge);
    // 初始只显第一组,第二组问题不可见。
    expect(screen.getByText("Q0")).toBeInTheDocument();
    expect(screen.queryByText("Q1")).toBeNull();
    expect(screen.getByRole("button", { name: "提交" })).toBeDisabled();
    expect(screen.getByText("还有 2 组未作答")).toBeInTheDocument();
    fireEvent.click(screen.getByText("A")); // 答第一组 → 自动跳到第二组
    expect(screen.getByText("Q1")).toBeInTheDocument(); // 已自动跳转,无需点 tab
    expect(screen.queryByText("Q0")).toBeNull();
    expect(screen.getByRole("button", { name: "提交" })).toBeDisabled(); // 仍缺第二组
    expect(screen.getByRole("tab", { name: /问题 1/ })).toHaveTextContent("✓"); // 已答 tab 标 ✓
    fireEvent.click(screen.getByText("Y")); // 答第二组(当前组)
    expect(screen.getByRole("button", { name: "提交" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(JSON.parse((lastResp(bridge)![2] as { value: string }).value)).toEqual({
      answers: [
        { groupId: "g0", value: "A", isCustom: false },
        { groupId: "g1", value: "Y", isCustom: false },
      ],
    });
  });

  it("自定义输入始终可用:选了选项后仍能改填自定义(last-action 互斥)", () => {
    const bridge = makeBridge();
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: askReq("a1", oneGroup) }] });
    renderCard(bridge);
    fireEvent.click(screen.getByText("选项A")); // 先选选项
    const input = screen.getByPlaceholderText("或自定义回答…");
    expect(input).toBeEnabled(); // 不再 disabled
    fireEvent.change(input, { target: { value: "改成自定义" } }); // 切到自定义 → 清选项
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(JSON.parse((lastResp(bridge)![2] as { value: string }).value)).toEqual({
      answers: [{ groupId: "g0", value: "改成自定义", isCustom: true }],
    });
  });

  it("单组:不渲染 tab 栏", () => {
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: askReq("a1", oneGroup) }] });
    renderCard(makeBridge());
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("取消按钮 → piUiResponse{cancelled}", () => {
    const bridge = makeBridge();
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: askReq("a1", oneGroup) }] });
    renderCard(bridge);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(lastResp(bridge)).toEqual(["s-pi", "a1", { cancelled: true }]);
  });

  it("ESC → piUiResponse{cancelled}", () => {
    const bridge = makeBridge();
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: askReq("a2", oneGroup) }] });
    renderCard(bridge);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(lastResp(bridge)).toEqual(["s-pi", "a2", { cancelled: true }]);
  });

  it("头部身份行:「向你提问」标题 + ✕ 关闭等价取消", () => {
    const bridge = makeBridge();
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: askReq("a1", oneGroup) }] });
    renderCard(bridge);
    expect(screen.getByText("向你提问")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(lastResp(bridge)).toEqual(["s-pi", "a1", { cancelled: true }]);
  });

  it("数字键 1-9 选当前组选项;Enter(非输入框焦点)提交", () => {
    const bridge = makeBridge();
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: askReq("a1", oneGroup) }] });
    renderCard(bridge);
    fireEvent.keyDown(window, { key: "2" }); // 选第二项「选项B」
    fireEvent.keyDown(window, { key: "Enter" });
    expect(JSON.parse((lastResp(bridge)![2] as { value: string }).value)).toEqual({
      answers: [{ groupId: "g0", value: "选项B", isCustom: false }],
    });
  });

  it("数字键在输入框聚焦时不劫持(自定义作答可正常输入数字)", () => {
    const bridge = makeBridge();
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: askReq("a1", oneGroup) }] });
    renderCard(bridge);
    const input = screen.getByPlaceholderText("或自定义回答…");
    fireEvent.keyDown(input, { key: "1" }); // 焦点在输入框:不应选中选项
    expect(screen.getByRole("button", { name: "提交" })).toBeDisabled();
  });

  it("自定义输入内回车 → 直接提交", () => {
    const bridge = makeBridge();
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: askReq("a1", oneGroup) }] });
    renderCard(bridge);
    const input = screen.getByPlaceholderText("或自定义回答…");
    fireEvent.change(input, { target: { value: "回车答案" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(JSON.parse((lastResp(bridge)![2] as { value: string }).value)).toEqual({
      answers: [{ groupId: "g0", value: "回车答案", isCustom: true }],
    });
  });

  it("会话隔离:uiSessionId ≠ 当前会话 → 不渲染(后台会话卡不冒头)", () => {
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-OTHER", request: askReq("a1", oneGroup) }] });
    renderCard(makeBridge(), "s-pi");
    expect(screen.queryByText("选哪个?")).toBeNull();
  });

  it("多卡排队:同会话两张 → 显队首,出队后显下一张", () => {
    const bridge = makeBridge();
    const g = (q: string) => ({ groups: [{ id: "g0", question: q, options: [{ label: "A" }], allowCustom: false }] });
    usePersonalStore.setState({
      piUiPending: [
        { uiSessionId: "s-pi", request: askReq("a1", g("第一问")) },
        { uiSessionId: "s-pi", request: askReq("a2", g("第二问")) },
      ],
    });
    renderCard(bridge);
    expect(screen.getByText("第一问")).toBeInTheDocument();
    expect(screen.queryByText("第二问")).toBeNull();
    fireEvent.click(screen.getByText("A"));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(screen.getByText("第二问")).toBeInTheDocument();
    expect(screen.queryByText("第一问")).toBeNull();
  });
});
