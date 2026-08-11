// 个人工作区共用的本地日期键。无项目会话目录、闪记与首页展示都按本地自然日归档，
// 因此不能使用 UTC 日期，否则跨时区/午夜时会落到错误目录或显示错误日期。
export function dayKey(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
