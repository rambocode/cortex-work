// 关窗草稿 flush 缝合层测试（R21/KTD6）：桥从 projects-window renderer 抽出后可独立在 jsdom 验证。
// 覆盖两条落数据路径：① main 的 flush-request（onFlushRequest 回调）→ flushPendingDrafts → flushDone；
// ② app 退出走的 window 'beforeunload' 同步兜底 → flushPendingDrafts。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectsFlushBridge, type ProjectsFlushApi } from "./ProjectsFlushBridge";
import { useTaskDraftField } from "./useTaskDraftField";

afterEach(cleanup);

// 挂一个已注册 pending 草稿的 useTaskDraftField 实例：聚焦编辑但不 blur（模拟关窗时正在输入），
// flushPendingDrafts 触发其 commit → onCommit 被调，据此断言桥确实执行了 flush。
function DraftHarness({ onCommit }: { onCommit: (v: string) => void }) {
  const draft = useTaskDraftField({ taskId: "t1", external: "A", onCommit });
  return (
    <input
      aria-label="draft"
      value={draft.value}
      onFocus={draft.onFocus}
      onChange={(e) => draft.setValue(e.target.value)}
      onBlur={draft.onBlur}
    />
  );
}

function renderBridge(api: ProjectsFlushApi | undefined, onCommit: (v: string) => void) {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <DraftHarness onCommit={onCommit} />
      <ProjectsFlushBridge api={api} />
    </QueryClientProvider>,
  );
  // 聚焦并改脏草稿（未 blur），使其成为待 flush 的 pending 项。
  const input = screen.getByLabelText("draft");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "A-edited" } });
}

describe("ProjectsFlushBridge（R21/KTD6）", () => {
  it("收到 main flush-request → flushPendingDrafts 提交 pending 草稿，随后 flushDone 回执", async () => {
    const onCommit = vi.fn();
    const flushDone = vi.fn();
    let flushCb: (() => void) | undefined;
    const api: ProjectsFlushApi = {
      onFlushRequest: vi.fn((cb) => {
        flushCb = cb;
        return () => {};
      }),
      flushDone,
    };
    renderBridge(api, onCommit);
    expect(api.onFlushRequest).toHaveBeenCalledTimes(1);

    // 模拟 main 拦截 close 后发来的 flush 请求。
    act(() => flushCb?.());
    expect(onCommit).toHaveBeenCalledWith("A-edited");
    // 无在途 mutation（qc.isMutating()===0）→ waitMutationsIdle 立即 resolve → flushDone。
    await waitFor(() => expect(flushDone).toHaveBeenCalledTimes(1));
  });

  it("window 'beforeunload' → flushPendingDrafts 同步兜底（app 退出不走握手）", () => {
    const onCommit = vi.fn();
    const api: ProjectsFlushApi = { onFlushRequest: vi.fn(() => () => {}), flushDone: vi.fn() };
    renderBridge(api, onCommit);

    act(() => {
      window.dispatchEvent(new Event("beforeunload"));
    });
    expect(onCommit).toHaveBeenCalledWith("A-edited");
  });

  it("api 缺省（Web 端无桥）不抛：仍注册 beforeunload 兜底", () => {
    const onCommit = vi.fn();
    expect(() => renderBridge(undefined, onCommit)).not.toThrow();
    act(() => {
      window.dispatchEvent(new Event("beforeunload"));
    });
    expect(onCommit).toHaveBeenCalledWith("A-edited");
  });
});
