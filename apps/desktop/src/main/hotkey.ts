// 全局热键(globalShortcut)注册结果 → 降级状态的纯函数。把「register 返回值」与
// 「降级标记 + 用户提示文案」解耦,便于单测;globalShortcut 本身的系统行为(实际唤起/
// 占用冲突)属人工验证。仿 logger.ts 等可测纯模块,不 import electron。

// 默认闪记热键键位(契约 8.5 / 待解问题 5)。register 与降级判定共用此常量,避免漂移。
export const NOTES_HOTKEY_ACCELERATOR = "CommandOrControl+Shift+N";

// 默认任务快速捕获热键键位(真任务系统 U5/KTD5)。**必须与闪记键不同**,否则两个全局键打架。
// 兜底键经 rebindCandidates 的 defaultAcc 入参传入,避免任务捕获降级时误注册成闪记键(研究 rank11)。
// 确切默认键位是 Open Question，可由用户设置覆盖。
export const TASKS_HOTKEY_ACCELERATOR = "CommandOrControl+Shift+K";

// register 失败(被占用)时给用户的提示文案。降级到仅窗口图标入口仍可用。
export const NOTES_HOTKEY_OCCUPIED_TOAST = "闪记热键被占用,改用窗口图标入口";

// accelerator 格式无效(渲染端录制兜底,正常 UI 不会传)时的提示文案。
export const NOTES_HOTKEY_INVALID_TOAST = "快捷键格式无效";

// 三级兜底全部落空(新键、旧键、默认键都注册失败)时的提示文案:此刻无任何可用绑定,
// 须引导用户改设一个未被占用的键。
export const NOTES_HOTKEY_UNAVAILABLE_TOAST = "闪记热键当前不可用,请重新设置一个未被占用的快捷键";

// Electron accelerator 修饰键(大小写不敏感比对)。来自官方 accelerator 文档。
const MODIFIER_TOKENS = new Set([
  "command",
  "cmd",
  "control",
  "ctrl",
  "commandorcontrol",
  "cmdorctrl",
  "alt",
  "option",
  "altgr",
  "shift",
  "super",
  "meta",
]);

// 命名主键(功能键 / 常见特殊键)。字母数字与单字符标点另行判定。
const NAMED_KEYS = new Set([
  "space",
  "tab",
  "backspace",
  "delete",
  "insert",
  "return",
  "enter",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "escape",
  "esc",
  "printscreen",
  "capslock",
  "numlock",
  "scrolllock",
  "plus", // 字面 "Plus"(与连接符 + 区分)
]);

// 单段是否为合法的「非修饰主键」:字母/数字、F1-F24、命名键、或单字符标点。
function isMainKeyToken(token: string): boolean {
  const t = token.toLowerCase();
  if (/^[a-z0-9]$/.test(t)) return true; // 单个字母或数字
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(t)) return true; // F1-F24
  if (NAMED_KEYS.has(t)) return true;
  // 单字符标点(`、-、= 等),排除空白与 +(+ 是连接符,需写成 "Plus")。
  if (token.length === 1 && token !== "+" && !/\s/.test(token)) return true;
  return false;
}

// accelerator 校验:至少 1 个修饰键 + 恰好 1 个非修饰主键,用 "+" 连接。
// 拒绝空串、纯修饰、无修饰裸键(防注册成拦截普通打字的全局键)、残缺/乱码。
export function isValidAccelerator(acc: string): boolean {
  if (!acc || !acc.trim()) return false;
  // 不允许首尾或连续 "+"(残缺段)。"+" 作为主键须写成 "Plus"。
  const parts = acc.split("+");
  if (parts.some((p) => p.length === 0)) return false;
  let modifiers = 0;
  let mainKeys = 0;
  for (const part of parts) {
    if (MODIFIER_TOKENS.has(part.toLowerCase())) {
      modifiers += 1;
    } else if (isMainKeyToken(part)) {
      mainKeys += 1;
    } else {
      return false; // 未知段
    }
  }
  return modifiers >= 1 && mainKeys === 1;
}

// 重绑决策(纯函数,不触碰 globalShortcut):给定旧键、欲设新键、以及主进程实际
// register 新键的返回值,推导出最终应处于活跃绑定的 accelerator + 降级状态。
// - 新键格式无效:不动旧键,降级提示「格式无效」。
// - 新键合法且 register 成功:切到新键,无降级。
// - 新键合法但被占用(newOk=false):回退旧键(保证始终有一个可用绑定),降级提示「占用」。
export interface RebindResult extends HotkeyRegistration {
  // 决策后应处于活跃绑定的 accelerator(调用方据此更新 currentNotesAccelerator)。
  activeAccelerator: string;
}

export function resolveRebind(oldAcc: string, newAcc: string, newOk: boolean): RebindResult {
  if (!isValidAccelerator(newAcc)) {
    return { registered: false, degraded: true, toast: NOTES_HOTKEY_INVALID_TOAST, activeAccelerator: oldAcc };
  }
  if (newOk) {
    return { registered: true, degraded: false, activeAccelerator: newAcc };
  }
  // 新键被占用:回退旧键。
  return {
    registered: false,
    degraded: true,
    toast: NOTES_HOTKEY_OCCUPIED_TOAST,
    activeAccelerator: oldAcc,
  };
}

// 三级兜底候选链(纯函数):按优先序「新键 → 旧键 → 默认键」给出应依次尝试 register
// 的 accelerator 列表。去重(保持首次出现的优先序)、跳过空串与非法值(旧键可能为空
// 或脏数据)。调用方按此列表逐个 register,首个成功即停。
// 注意:新键合法性由调用方先行 isValidAccelerator 校验;此处仅负责构造去重后的候选序列。
// defaultAcc 为末级兜底键,缺省闪记键;任务捕获须传 TASKS_HOTKEY_ACCELERATOR,避免降级误注册成
// 闪记键(研究 rank11)。
export function rebindCandidates(
  newAcc: string,
  oldAcc: string,
  defaultAcc: string = NOTES_HOTKEY_ACCELERATOR,
): string[] {
  const ordered = [newAcc, oldAcc, defaultAcc];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const acc of ordered) {
    if (!acc || seen.has(acc) || !isValidAccelerator(acc)) continue;
    seen.add(acc);
    out.push(acc);
  }
  return out;
}

// 三级兜底决策(纯函数):给定旧键、欲设新键、候选链(rebindCandidates 产物)以及调用
// 方逐个 register 后「首个成功的候选下标」(全部失败为 -1),推导最终态:
// - 新键格式无效(successIdx<0 且新键非法)→ 不动旧键,降级提示「格式无效」。
// - successIdx===0(新键本身成功)→ 切到新键,无降级。
// - successIdx>0(回退到旧键或默认键成功)→ 降级提示「占用」,active=该候选键。
// - successIdx<0 且新键合法(全部候选都失败)→ 无可用绑定,active 置空,降级提示「不可用」。
export function resolveRebindChain(
  oldAcc: string,
  newAcc: string,
  candidates: string[],
  successIdx: number,
): RebindResult {
  if (!isValidAccelerator(newAcc)) {
    return { registered: false, degraded: true, toast: NOTES_HOTKEY_INVALID_TOAST, activeAccelerator: oldAcc };
  }
  if (successIdx === 0) {
    return { registered: true, degraded: false, activeAccelerator: candidates[0] ?? newAcc };
  }
  if (successIdx > 0) {
    // 回退到旧键 / 默认键成功:始终保有一个可用绑定,但用户想要的新键未生效 → 占用降级。
    return {
      registered: false,
      degraded: true,
      toast: NOTES_HOTKEY_OCCUPIED_TOAST,
      activeAccelerator: candidates[successIdx] ?? "",
    };
  }
  // 全部候选都失败:无任何可用绑定。
  return { registered: false, degraded: true, toast: NOTES_HOTKEY_UNAVAILABLE_TOAST, activeAccelerator: "" };
}

export interface HotkeyRegistration {
  // register 是否成功(true = 热键可用;false = 被占用,已降级)。
  registered: boolean;
  // 是否进入降级态(仅窗口图标入口可用)。
  degraded: boolean;
  // 降级时给用户的提示文案;未降级为 undefined。
  toast?: string;
}

// globalShortcut.register 返回值 → 降级状态。ok=true 无降级;ok=false 降级且带提示。
export function resolveHotkeyRegistration(ok: boolean): HotkeyRegistration {
  if (ok) return { registered: true, degraded: false };
  return { registered: false, degraded: true, toast: NOTES_HOTKEY_OCCUPIED_TOAST };
}
