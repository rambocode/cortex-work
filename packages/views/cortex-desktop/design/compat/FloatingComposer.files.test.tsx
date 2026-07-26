import { createElement } from "react";
import { fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  FloatingComposer,
  type ComposerPendingTextFile,
} from "./FloatingComposer";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k }),
}));

const base = { input: "", setInput: () => {}, onSend: () => {} };
const md = (name = "brief.md"): File => new File(["hello"], name, { type: "text/markdown" });
const png = (): File => new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
const transfer = (...files: File[]): { files: File[] } => ({ files });
const pending = (id = "f1"): ComposerPendingTextFile => ({
  id,
  name: "brief.md",
  sizeBytes: 5,
  content: "hello",
});

describe("FloatingComposer 文本文件", () => {
  it("未接线时不显示文件入口", () => {
    const { queryByLabelText } = render(createElement(FloatingComposer, base));
    expect(queryByLabelText(/添加文件/)).toBeNull();
  });

  it("选择 md 文件后交给宿主", () => {
    const onAddTextFiles = vi.fn();
    const { container } = render(
      createElement(FloatingComposer, {
        ...base,
        onAddTextFiles,
        textFileAccept: ".md,.txt",
      }),
    );
    const input = container.querySelector('input[accept=".md,.txt"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [md()] } });
    expect(onAddTextFiles).toHaveBeenCalledWith([expect.objectContaining({ name: "brief.md" })]);
  });

  it("混合拖入图片和 md 时各走各的回调", () => {
    const onAddImages = vi.fn();
    const onAddTextFiles = vi.fn();
    const { container } = render(
      createElement(FloatingComposer, { ...base, onAddImages, onAddTextFiles }),
    );
    const event = new Event("drop", { bubbles: true, cancelable: true }) as Event & {
      dataTransfer?: unknown;
    };
    event.dataTransfer = transfer(png(), md());
    container.firstElementChild!.dispatchEvent(event);
    expect(onAddImages).toHaveBeenCalledWith([expect.objectContaining({ name: "shot.png" })]);
    expect(onAddTextFiles).toHaveBeenCalledWith([expect.objectContaining({ name: "brief.md" })]);
  });

  it("只有图片接线时拖入 md 不触发任何回调", () => {
    const onAddImages = vi.fn();
    const { container } = render(createElement(FloatingComposer, { ...base, onAddImages }));
    const event = new Event("drop", { bubbles: true, cancelable: true }) as Event & {
      dataTransfer?: unknown;
    };
    event.dataTransfer = transfer(md());
    container.firstElementChild!.dispatchEvent(event);
    expect(onAddImages).not.toHaveBeenCalled();
  });

  it("待发文件 chip 可移除", async () => {
    const removed: string[] = [];
    const { getByTestId, getByLabelText } = render(
      createElement(FloatingComposer, {
        ...base,
        onAddTextFiles: () => {},
        textFiles: [pending()],
        onRemoveTextFile: (id: string) => removed.push(id),
      }),
    );
    expect(getByTestId("composer-text-files").textContent).toContain("brief.md");
    await userEvent.click(getByLabelText("移除文件: brief.md"));
    expect(removed).toEqual(["f1"]);
  });

  it("只有文件没有文字时发送按钮可用", () => {
    const { getByRole } = render(
      createElement(FloatingComposer, {
        ...base,
        onAddTextFiles: () => {},
        textFiles: [pending()],
      }),
    );
    expect((getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
