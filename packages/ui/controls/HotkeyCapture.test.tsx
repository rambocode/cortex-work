// 录制式快捷键控件:点击进入录制态、模拟 keydown 触发 onChange、Esc 取消、失焦退出。

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HotkeyCapture } from "./HotkeyCapture";

describe("HotkeyCapture", () => {
  it("常态显示格式化后的当前值", () => {
    render(<HotkeyCapture value="CommandOrControl+Shift+N" isMac onChange={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent("⌘⇧N");
  });

  it("点击进入录制态显示提示文案", () => {
    render(<HotkeyCapture value="CommandOrControl+Shift+N" isMac onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("按下快捷键");
  });

  it("录制态按下合法组合 → onChange(accelerator) 并退出录制", () => {
    const onChange = vi.fn();
    render(<HotkeyCapture value="CommandOrControl+Shift+N" isMac onChange={onChange} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    fireEvent.keyDown(btn, { metaKey: true, shiftKey: true, code: "KeyM", key: "m" });
    expect(onChange).toHaveBeenCalledWith("CommandOrControl+Shift+M");
    // 退出录制 → 显示新值(由 value prop 控制;此处仍展示旧值的格式,但提示文案应消失)
    expect(btn).not.toHaveTextContent("按下快捷键");
  });

  it("录制态按 Esc 取消,不触发 onChange", () => {
    const onChange = vi.fn();
    render(<HotkeyCapture value="CommandOrControl+Shift+N" isMac onChange={onChange} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    fireEvent.keyDown(btn, { key: "Escape", code: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(btn).not.toHaveTextContent("按下快捷键");
  });

  it("录制态纯修饰键不结束录制(等主键)", () => {
    const onChange = vi.fn();
    render(<HotkeyCapture value="CommandOrControl+Shift+N" isMac onChange={onChange} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    fireEvent.keyDown(btn, { metaKey: true, code: "MetaLeft", key: "Meta" });
    expect(onChange).not.toHaveBeenCalled();
    expect(btn).toHaveTextContent("按下快捷键");
  });

  it("失焦退出录制态", () => {
    render(<HotkeyCapture value="CommandOrControl+Shift+N" isMac onChange={() => {}} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    expect(btn).toHaveTextContent("按下快捷键");
    fireEvent.blur(btn);
    expect(btn).not.toHaveTextContent("按下快捷键");
  });

  it("录制态按未映射键(有主键但 accelerator 为 null)→ 提示「无法识别」且仍在录制态,不触发 onChange", () => {
    const onChange = vi.fn();
    render(<HotkeyCapture value="CommandOrControl+Shift+N" isMac onChange={onChange} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    // Lang1 等未映射键:有修饰键但 eventToAccelerator 返回 null。
    fireEvent.keyDown(btn, { metaKey: true, code: "Lang1", key: "Unidentified" });
    expect(onChange).not.toHaveBeenCalled();
    expect(btn).toHaveTextContent("无法识别");
    // 仍处于录制态:闪一下提示后控件仍在录制(aria-pressed 为 true)。
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  it("录制态纯修饰键仍静默(不显示「无法识别」,继续等主键)", () => {
    const onChange = vi.fn();
    render(<HotkeyCapture value="CommandOrControl+Shift+N" isMac onChange={onChange} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    fireEvent.keyDown(btn, { metaKey: true, code: "MetaLeft", key: "Meta" });
    expect(onChange).not.toHaveBeenCalled();
    expect(btn).not.toHaveTextContent("无法识别");
    expect(btn).toHaveTextContent("按下快捷键");
  });
});
