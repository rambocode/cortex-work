// Electron accelerator → macOS CGEvent key code 的纯映射。
//
// 按住听写由 Cortex_Helper 的 event tap 拦截，必须知道真实物理键位，不能把 Electron
// 支持的所有抽象键名都猜测成 CGKeyCode。这里刻意只接受 ANSI 主键；无法无歧义映射的
// 功能键、导航键等一律拒绝，让设置页提示用户改用受支持的组合，避免错误吞键。

/** 设置页应展示的按住听写键位失败提示。 */
export const HOLD_HOTKEY_UNSUPPORTED_MESSAGE = "该键不支持按住模式";

/** 与 Cortex_Helper `flag(for:)` 及 dictation config 的 modifiers 字段保持一致。 */
export type DictationModifier = "command" | "control" | "option" | "shift" | "function";

/** 可直接作为 Cortex_Helper `config.dictation` 发送的键位配置。 */
export interface DictationKeyCodeConfig {
  /** ANSI 主键的 macOS virtual key code；null 表示纯修饰键组合。 */
  keyCode: number | null;
  /** 需要同时按住的修饰键。 */
  modifiers: DictationModifier[];
}

/** accelerator 映射结果；失败时不返回部分配置，调用方不得下发旧值与新值的混合态。 */
export type AcceleratorKeyCodeResult =
  | { ok: true; config: DictationKeyCodeConfig }
  | { ok: false; message: typeof HOLD_HOTKEY_UNSUPPORTED_MESSAGE };

// Carbon kVK_ANSI_* 常量值。只列出 US ANSI 主键盘上不需要布局猜测的物理键位。
const ANSI_KEY_CODES: Readonly<Record<string, number>> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "=": 24,
  "9": 25,
  "7": 26,
  "-": 27,
  "8": 28,
  "0": 29,
  "]": 30,
  o: 31,
  u: 32,
  "[": 33,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  "'": 39,
  k: 40,
  ";": 41,
  "\\": 42,
  ",": 43,
  "/": 44,
  n: 45,
  m: 46,
  ".": 47,
  "`": 50,
  space: 49,
};

const MODIFIER_ALIASES: Readonly<Record<string, DictationModifier>> = {
  command: "command",
  cmd: "command",
  commandorcontrol: "command",
  cmdorctrl: "command",
  control: "control",
  ctrl: "control",
  option: "option",
  alt: "option",
  shift: "shift",
  function: "function",
  fn: "function",
};

/**
 * 将 Electron accelerator 转换为 helper 能精确监听的 macOS ANSI 键位。
 *
 * 纯修饰组合合法，`keyCode: null` 让 Swift 侧以 flagsChanged 判断「全部按下开始、任一松开结束」；
 * 含主键组合只接受一个 ANSI 键，由 Swift 在 keyDown/keyUp 中配对处理。
 */
export function mapAcceleratorToMacKeyCode(accelerator: string): AcceleratorKeyCodeResult {
  const parts = accelerator.split("+");
  if (!accelerator.trim() || parts.some((part) => !part.trim())) return unsupported();

  const modifiers: DictationModifier[] = [];
  let keyCode: number | null = null;

  for (const rawPart of parts) {
    const part = rawPart.trim();
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier) {
      // 重复修饰键不会改变 flags，但通常意味着录制值异常；拒绝可避免配置含混。
      if (modifiers.includes(modifier)) return unsupported();
      modifiers.push(modifier);
      continue;
    }

    const mappedKeyCode = ansiKeyCode(part);
    // 只允许一个普通键。纯修饰键会保留 keyCode 为 null。
    if (mappedKeyCode == null || keyCode != null) return unsupported();
    keyCode = mappedKeyCode;
  }

  // 不带修饰键的 keyDown 会吞掉用户正常输入，绝不能作为全局按住触发器。
  if (modifiers.length === 0) return unsupported();
  return { ok: true, config: { keyCode, modifiers } };
}

/** 从字母大小写、数字、ANSI 标点及 Electron 的 Space 名称取得稳定物理键码。 */
function ansiKeyCode(token: string): number | null {
  return ANSI_KEY_CODES[token.toLowerCase()] ?? null;
}

function unsupported(): AcceleratorKeyCodeResult {
  return { ok: false, message: HOLD_HOTKEY_UNSUPPORTED_MESSAGE };
}
