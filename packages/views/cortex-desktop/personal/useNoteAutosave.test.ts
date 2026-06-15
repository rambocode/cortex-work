import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNoteAutosave } from "./useNoteAutosave";

afterEach(cleanup);
beforeEach(() => vi.useRealTimers());

describe("useNoteAutosave", () => {
  it("去抖:连续输入只在停止 ~500ms 后保存一次,内容为最终值", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useNoteAutosave({ noteId: "n1", content: "", onSave, debounceMs: 500 }),
    );

    act(() => result.current.setDraft("a"));
    act(() => result.current.setDraft("ab"));
    act(() => result.current.setDraft("abc"));
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("abc");
  });

  it("flush-on-unmount:去抖未到点即卸载,挂起内容仍被保存(不丢尾字)", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(async () => {});
    const { result, unmount } = renderHook(() =>
      useNoteAutosave({ noteId: "n1", content: "", onSave, debounceMs: 500 }),
    );

    act(() => result.current.setDraft("尾字"));
    // 不推进定时器,直接卸载
    unmount();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("尾字");
  });

  it("防回灌:同一 noteId 下 content 变化不复位 draft(编辑中不被 refetch 覆盖)", () => {
    const onSave = vi.fn(async () => {});
    const { result, rerender } = renderHook(
      ({ content }) => useNoteAutosave({ noteId: "n1", content, onSave, debounceMs: 500 }),
      { initialProps: { content: "orig" } },
    );

    act(() => result.current.setDraft("用户正在编辑"));
    // 模拟 notes:changed → refetch 回灌了不同的 content(同一 noteId)
    rerender({ content: "服务端旧值" });
    // draft 不应被覆盖
    expect(result.current.draft).toBe("用户正在编辑");
  });

  it("切换 noteId:flush 旧 note 的挂起保存,并复位 draft 为新 note 内容", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(async () => {});
    const { result, rerender } = renderHook(
      ({ noteId, content }) => useNoteAutosave({ noteId, content, onSave, debounceMs: 500 }),
      { initialProps: { noteId: "n1", content: "n1 内容" } },
    );

    act(() => result.current.setDraft("n1 改动"));
    // 切到 n2(未推进定时器)
    rerender({ noteId: "n2", content: "n2 内容" });
    // 旧 note 的挂起改动被 flush
    expect(onSave).toHaveBeenCalledWith("n1 改动");
    // draft 复位为新 note 内容
    expect(result.current.draft).toBe("n2 内容");
  });

  it("手动 save():立即保存,置 saved 态", async () => {
    const onSave = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useNoteAutosave({ noteId: "n1", content: "", onSave, debounceMs: 500 }),
    );
    act(() => result.current.setDraft("hi"));
    await act(async () => {
      await result.current.save();
    });
    expect(onSave).toHaveBeenCalledWith("hi");
    expect(result.current.status).toBe("saved");
  });

  it("保存失败:置 error 态并回调 onError,保留 draft", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("boom");
    });
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useNoteAutosave({ noteId: "n1", content: "", onSave, onError, debounceMs: 500 }),
    );
    act(() => result.current.setDraft("x"));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.status).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current.draft).toBe("x");
  });

  it("内容未变时手动 save 不触发写盘(去重)", async () => {
    const onSave = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useNoteAutosave({ noteId: "n1", content: "same", onSave, debounceMs: 500 }),
    );
    await act(async () => {
      await result.current.save();
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });
});
