// 浏览器「网站权限」白名单的 origin 归一——渲染端输入校验与主进程 url-gate 比较**共用本函数**,
// 保证两端口径一致(均为 URL.origin:小写 scheme+host+port、无路径、无尾斜杠)。否则 trailing slash /
// scheme 大小写差异会让白名单永久匹配不上(plan RISK-11)。仅接受 http(s);非法或非 http(s) → null。
export function normalizeOrigin(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}
