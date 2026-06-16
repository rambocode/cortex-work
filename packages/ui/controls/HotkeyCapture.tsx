// 录制式快捷键控件:常态显示当前键位 + 「点击修改」;点击进入录制态,监听 keydown
// 把按键组合映射成 Electron accelerator,得到非 null 即 onChange + 退出;Esc / 失焦取消。
// 纯 UI:不引 core、不碰 window —— isMac 由调用方传入,最终可注册性由主进程校验为准。

import { useEffect, useRef, useState } from "react";
import { eventToAccelerator, formatAccelerator, isModifierOnlyCode } from "./hotkeyAccelerator";

// 「无法识别此键」提示的闪现时长(ms);过后恢复常规录制提示。
const UNRECOGNIZED_HINT_MS = 1400;

export interface HotkeyCaptureProps {
  // 当前 accelerator(Electron 形如 "CommandOrControl+Shift+N")。
  value: string;
  // 录制到合法组合时回调(已是归一化 accelerator)。
  onChange: (acc: string) => void;
  // 显示格式:mac 用 ⌘⌥⇧ 符号,非 mac 用 Ctrl/Alt/Shift 文字。
  isMac?: boolean;
  // 常态空值时的占位提示(value 为空才用)。
  placeholder?: string;
}

export function HotkeyCapture({ value, onChange, isMac = false, placeholder }: HotkeyCaptureProps) {
  const [recording, setRecording] = useState(false);
  // 录制态按下「有主键但无法映射」(AltGr / 未映射键)时短暂置 true,闪现提示后自动恢复。
  const [unrecognized, setUnrecognized] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清理闪现定时器,避免对已卸载组件 setState。
  useEffect(() => {
    return () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, []);

  // 退出录制(Esc / 失焦 / 录制成功):同时清掉「无法识别」闪现态与定时器。
  const exitRecording = () => {
    if (hintTimer.current) {
      clearTimeout(hintTimer.current);
      hintTimer.current = null;
    }
    setUnrecognized(false);
    setRecording(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    // 录制态拦截一切按键,避免触发页面默认行为(如 Tab 移焦、空格滚动)。
    e.preventDefault();
    e.stopPropagation();
    // Esc:退出录制,不改值。
    if (e.key === "Escape") {
      exitRecording();
      return;
    }
    const acc = eventToAccelerator({
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      code: e.code,
      key: e.key,
    });
    if (acc) {
      exitRecording();
      onChange(acc);
      return;
    }
    // acc 为 null 两种情形:
    // - 纯修饰键(还在等主键)→ 静默,继续录制。
    // - 有主键但无法映射(AltGr / 未映射键)→ 闪现「无法识别」提示,不退出录制。
    if (isModifierOnlyCode(e.code)) return;
    setUnrecognized(true);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => {
      setUnrecognized(false);
      hintTimer.current = null;
    }, UNRECOGNIZED_HINT_MS);
  };

  const display = recording
    ? unrecognized
      ? "无法识别此键,请换一个"
      : "按下快捷键…(Esc 取消)"
    : value
      ? formatAccelerator(value, isMac)
      : (placeholder ?? "未设置");

  return (
    <button
      type="button"
      className={`twk-hotkey ${recording ? "is-recording" : ""} ${unrecognized ? "is-invalid" : ""}`}
      aria-label="录制快捷键"
      aria-pressed={recording}
      onClick={() => setRecording(true)}
      onKeyDown={handleKeyDown}
      onBlur={exitRecording}
    >
      <span className="twk-hotkey-val">{display}</span>
      {recording ? null : <span className="twk-hotkey-hint">点击修改</span>}
    </button>
  );
}
