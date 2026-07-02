// 工作台字段偏好纯逻辑：显示字段 / 编辑字段两组勾选的类型、默认值与容错解析。
// 本文件不碰 localStorage —— 读写落库由容器负责，这里只提供纯函数（便于单测且不引入平台副作用）。
// 解析容错范式参照 ProjectsWorkbench.tsx 的 readViewOptions：坏值全默认、缺字段逐键补默认。

// 中栏行「只读精简」态可展示的字段集合。
export type DisplayField =
  | "project"
  | "tags"
  | "duration"
  | "defer"
  | "due"
  | "repeat"
  | "reminder"
  | "status"
  | "note";

// 详情栏「完整编辑」态可展示的字段集合（与 DisplayField 略有差异：多 done，note→notes，无 status）。
export type EditField =
  | "project"
  | "tags"
  | "duration"
  | "defer"
  | "due"
  | "done"
  | "repeat"
  | "reminder"
  | "notes";

// 字段中文标签与任务字段语义一一对应；顺序即 popover 内的展示顺序。
export const DISPLAY_FIELDS: readonly { key: DisplayField; label: string }[] = [
  { key: "project", label: "所属项目" },
  { key: "tags", label: "标签" },
  { key: "duration", label: "预估时长" },
  { key: "defer", label: "推迟日期" },
  { key: "due", label: "截止日期" },
  { key: "repeat", label: "重复" },
  { key: "reminder", label: "提醒" },
  { key: "status", label: "状态提示" },
  { key: "note", label: "备注" },
];

export const EDIT_FIELDS: readonly { key: EditField; label: string }[] = [
  { key: "project", label: "所属项目" },
  { key: "tags", label: "标签" },
  { key: "duration", label: "预估时长" },
  { key: "defer", label: "推迟日期" },
  { key: "due", label: "截止日期" },
  { key: "done", label: "完成勾选" },
  { key: "repeat", label: "重复" },
  { key: "reminder", label: "提醒" },
  { key: "notes", label: "备注" },
];

export type DisplayFieldPrefs = Record<DisplayField, boolean>;
export type EditFieldPrefs = Record<EditField, boolean>;

// 从字段定义构造「全 true」默认偏好：缺省全开 → 零回归（老用户看到全部字段）。
function buildDefault<K extends string>(fields: readonly { key: K }[]): Record<K, boolean> {
  const out = {} as Record<K, boolean>;
  for (const { key } of fields) out[key] = true;
  return out;
}

export const DEFAULT_DISPLAY_FIELDS: DisplayFieldPrefs = buildDefault(DISPLAY_FIELDS);
export const DEFAULT_EDIT_FIELDS: EditFieldPrefs = buildDefault(EDIT_FIELDS);

// 通用容错解析：null / 坏 JSON / 非对象 → 全默认；逐键补默认；未知键丢弃；非 boolean 值回默认。
// 两个 parse 共用此泛型 helper，避免重复解析逻辑。
function parseFields<K extends string>(
  raw: string | null,
  fields: readonly { key: K }[],
  defaults: Record<K, boolean>,
): Record<K, boolean> {
  if (!raw) return { ...defaults };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...defaults };
  }
  // 非对象（含 null / 数组 / 原始值）一律回全默认。
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...defaults };
  }
  const src = parsed as Record<string, unknown>;
  const out = {} as Record<K, boolean>;
  // 只遍历已知字段：未知键自然被丢弃；缺字段或非 boolean 值回默认。
  for (const { key } of fields) {
    const v = src[key];
    out[key] = typeof v === "boolean" ? v : defaults[key];
  }
  return out;
}

// 解析显示字段偏好（容错见 parseFields）。
export function parseDisplayFields(raw: string | null): DisplayFieldPrefs {
  return parseFields(raw, DISPLAY_FIELDS, DEFAULT_DISPLAY_FIELDS);
}

// 解析编辑字段偏好（容错见 parseFields）。
export function parseEditFields(raw: string | null): EditFieldPrefs {
  return parseFields(raw, EDIT_FIELDS, DEFAULT_EDIT_FIELDS);
}
