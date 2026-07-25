/// 需要「服务端 stealth 抓取」的域名清单。
///
/// **为什么要清单，而不是「所有 403/429 都甩给服务端」**：
///   1. 服务端每次抓取要起一个 Camoufox 进程（约 5s、几百 MB 内存、并发上限 2）。
///      无条件降级会让一轮研究里十几个 403 候选把服务端排队排到超时。
///   2. 抓取 URL 会离开本机（发到 backend）。这是一条新增的出站信息通道，
///      应当只对确实需要的域名开放，而不是对所有失败的 URL 默认开放。
///   3. 缩小攻击面：命中清单才转发，等于给「让服务器去访问任意 URL」这件事加了一道白名单。
///
/// 判定用**后缀匹配**（`zhihu.com` 覆盖 `zhuanlan.zhihu.com`），不是全等：
/// 同一站点的内容子域会不断增加，逐个枚举必然漏。
///
/// 清单里的每一条都应当是**实测**过「本地抓不到、服务端能抓到」的域名，不要凭印象加：
/// 加错了只是白等一轮服务端往返（5s），但会挤占并发额度。
export const STEALTH_FETCH_DOMAINS: readonly string[] = [
  // 实测：纯 HTTP 403；agent-browser 起的真 Chrome 被判 40362「请求存在异常」；
  // Camoufox 3/3 拿到完整正文（98680 / 9000 / 4065 字）。
  "zhihu.com",
];

/// 归一化域名：小写 + 去掉末尾的点（DNS 根点）+ 去掉端口。
function normalizeHost(host: string): string {
  let out = host.trim().toLowerCase();
  // IPv6 字面量带方括号，端口切分要放在方括号之后处理；这里只需要剥掉端口。
  if (!out.startsWith("[")) {
    const colon = out.lastIndexOf(":");
    if (colon > 0) out = out.slice(0, colon);
  }
  while (out.endsWith(".")) out = out.slice(0, -1);
  return out;
}

/// 判断一个域名是否需要走服务端 stealth 抓取。
///
/// 后缀匹配时**必须要求点边界**：直接用 endsWith 会让 `evilzhihu.com` 命中 `zhihu.com`。
/// 这不只是误判，还等于让攻击者能把任意域名塞进「可以让服务器去访问」的白名单。
export function needsStealthFetch(
  host: string,
  domains: readonly string[] = STEALTH_FETCH_DOMAINS,
): boolean {
  const normalized = normalizeHost(host);
  if (normalized.length === 0) return false;
  return domains.some((raw) => {
    const domain = normalizeHost(raw);
    if (domain.length === 0) return false;
    return normalized === domain || normalized.endsWith(`.${domain}`);
  });
}
