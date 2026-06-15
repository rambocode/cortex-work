// 录制式快捷键的纯函数:把浏览器 KeyboardEvent 映射成 Electron accelerator,以及
// 把 accelerator 格式化为显示串(mac 用 ⌘⌥⇧ 符号,非 mac 用文字)。
// 不引 core、不碰 window —— 纯输入输出,便于单测。最终是否可注册由主进程校验为准,
// 本模块只负责「捕获 + 展示」。

// 录制时只取这几个字段(KeyboardEvent 的子集),便于在测试里构造最小事件。
export interface KeyEventLike {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  // 物理键位(与键盘布局/Shift 无关),取主键的首选来源。
  code: string;
  // 退化兜底(极少用到);主键优先 e.code。
  key: string;
}

// 修饰键本身的 e.code 前缀:按下时不应被当作主键。
const MODIFIER_CODE_PREFIXES = ["Meta", "Control", "Alt", "Shift"];

// e.code 是否为「纯修饰键」(MetaLeft / ControlRight / AltLeft / ShiftLeft 等)。
// 用于区分「仅按修饰键、还在等主键」(应静默)与「按了主键但无法映射」(应提示)。
export function isModifierOnlyCode(code: string): boolean {
  return MODIFIER_CODE_PREFIXES.some((p) => code.startsWith(p));
}

// e.code → Electron accelerator 主键名。仅收录常见键;未命中返回 null(交调用方拦)。
const NAMED_CODE_MAP: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  // 标点/符号键(取 Electron 接受的字面符号)。
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

// 把单个物理键位 e.code 映射成 accelerator 主键名;不可识别返回 null。
function codeToMainKey(code: string): string | null {
  // 字母:KeyA-KeyZ → A-Z。
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1];
  // 主键盘数字:Digit0-Digit9 → 0-9。
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit?.[1]) return digit[1];
  // 小键盘数字:Numpad0-Numpad9 → 0-9。
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad?.[1]) return numpad[1];
  // 功能键:F1-F24 原样。
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  // 命名键 / 符号。
  return NAMED_CODE_MAP[code] ?? null;
}

// KeyboardEvent → Electron accelerator。
// - metaKey || ctrlKey → "CommandOrControl"(跨平台,⌘ 与 Ctrl 都映射到同一令牌)。
// - altKey → "Alt";shiftKey → "Shift"。
// - 主键取自 e.code(避免 Shift 改变 e.key 字符);仅修饰键时返回 null。
// - 无主键或无修饰返回 null(交调用方拦,防注册成拦截普通打字的裸键)。
// 修饰键顺序固定:CommandOrControl → Alt → Shift → 主键。
export function eventToAccelerator(e: KeyEventLike): string | null {
  // 仅按下修饰键本身(主键是 Meta/Control/Alt/Shift)→ 还没按主键,返回 null。
  if (isModifierOnlyCode(e.code)) return null;

  const mainKey = codeToMainKey(e.code);
  if (!mainKey) return null;

  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  // 无任何修饰键的裸键不允许(防全局拦截普通打字)。
  if (parts.length === 0) return null;

  parts.push(mainKey);
  return parts.join("+");
}

// 显示用格式化。mac 下用符号且无分隔(⌘⇧N);非 mac 下用文字 + 连接(Ctrl+Shift+N)。
const MAC_SYMBOL: Record<string, string> = {
  commandorcontrol: "⌘",
  cmdorctrl: "⌘",
  command: "⌘",
  cmd: "⌘",
  control: "⌃",
  ctrl: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
  super: "⌘",
  meta: "⌘",
};
const WIN_LABEL: Record<string, string> = {
  commandorcontrol: "Ctrl",
  cmdorctrl: "Ctrl",
  command: "Win",
  cmd: "Win",
  control: "Ctrl",
  ctrl: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  super: "Win",
  meta: "Win",
};

export function formatAccelerator(acc: string, isMac: boolean): string {
  if (!acc) return acc;
  const parts = acc.split("+");
  const last = parts.length - 1;
  if (isMac) {
    // mac:修饰键转符号无分隔,主键大写。
    return parts
      .map((p, i) => {
        if (i === last) return p.length === 1 ? p.toUpperCase() : p;
        return MAC_SYMBOL[p.toLowerCase()] ?? p;
      })
      .join("");
  }
  // 非 mac:修饰键转文字,主键大写,用 + 连接。
  return parts
    .map((p, i) => {
      if (i === last) return p.length === 1 ? p.toUpperCase() : p;
      return WIN_LABEL[p.toLowerCase()] ?? p;
    })
    .join("+");
}
