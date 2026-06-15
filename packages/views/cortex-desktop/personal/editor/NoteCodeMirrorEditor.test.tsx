import { render, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteCodeMirrorEditor } from "./NoteCodeMirrorEditor";

afterEach(cleanup);

// CodeMirror 走 useEffect 内动态 import(KTD3),且布局相关行为在 jsdom 下不可靠,
// 故此处只做装载接线的冒烟:实例挂载、初始内容进文档、销毁清理。光标/滚动/三档切换
// 的视觉行为由人工验证。
describe("NoteCodeMirrorEditor", () => {
  it("挂载后异步装载 CodeMirror 实例并注入初始内容", async () => {
    const { container } = render(
      <NoteCodeMirrorEditor value="# 标题\n正文" appearance="live" onChange={vi.fn()} onSave={vi.fn()} />,
    );
    // host 立即在;CM 实例在动态 import 完成后挂入。
    expect(container.querySelector(".pw-note-cm-host")).not.toBeNull();
    await waitFor(
      () => {
        expect(container.querySelector(".cm-editor")).not.toBeNull();
      },
      { timeout: 5000 },
    );
    expect(container.querySelector(".cm-content")?.textContent ?? "").toContain("标题");
  });

  it("卸载时销毁编辑器实例,不残留 .cm-editor", async () => {
    const { container, unmount } = render(
      <NoteCodeMirrorEditor value="hello" appearance="source" onChange={vi.fn()} onSave={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull(), { timeout: 5000 });
    unmount();
    expect(container.querySelector(".cm-editor")).toBeNull();
  });
});
