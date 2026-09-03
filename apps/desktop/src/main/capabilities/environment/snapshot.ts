// 运行环境快照的纯逻辑:探测脚本、探测输出解析、以及渲染给模型看的 <environment> 提示词块。
//
// 为什么要有这一块:模型写 shell 命令时会「猜」这台电脑装了什么(典型:`from bs4 import BeautifulSoup`
// → ModuleNotFoundError),猜错就是一次用户可见的红字报错,再自己换方案又是一轮 token。把机器上
// 真实存在的运行时 / 常用模块 / CLI 列进系统提示的静态前缀,让它不用猜。
//
// 本文件不 import electron / child_process,所有函数都是纯函数,便于单测;真正跑命令在 probe.ts。

/** 探测的 Python 第三方模块清单:按「模型最爱盲猜」的顺序排,不求全。 */
export const PROBED_PYTHON_MODULES = [
  "bs4",
  "lxml",
  "requests",
  "httpx",
  "pandas",
  "numpy",
  "openpyxl",
  "pypdf",
  "PyPDF2",
  "docx",
  "pptx",
  "PIL",
  "yaml",
  "matplotlib",
  "markdown",
] as const;

/** 探测的 CLI 工具清单:同样只列模型常盲用的那些。 */
export const PROBED_CLI_TOOLS = [
  "git",
  "jq",
  "rg",
  "fd",
  "curl",
  "wget",
  "ffmpeg",
  "pandoc",
  "sqlite3",
  "uv",
  "pip3",
  "brew",
  "node",
  "npm",
  "pnpm",
  "bun",
] as const;

/** 一次环境探测的结果;字段为 null 表示该项探测不到(而非探测失败整体作废)。 */
export interface EnvironmentSnapshot {
  platform: string; // process.platform,如 darwin / win32 / linux
  arch: string;
  osVersion: string | null; // macOS 产品版本(sw_vers)或内核 release;探不到为 null
  shell: string; // 登录 shell 路径
  pythonVersion: string | null; // python3 不可用为 null
  pythonModules: string[]; // 已安装的探测模块(PROBED_PYTHON_MODULES 子集)
  nodeVersion: string | null;
  cliTools: string[]; // 已安装的探测 CLI(PROBED_CLI_TOOLS 子集)
}

// 探测脚本各段的分隔标记:一次登录 shell 调用跑完所有探测,按标记切段解析。
const MARK_PY = "__CORTEX_PY__";
const MARK_NODE = "__CORTEX_NODE__";
const MARK_CLI = "__CORTEX_CLI__";
const MARK_OS = "__CORTEX_OS__";
const NONE = "__NONE__";

/**
 * 生成在登录 shell 里执行的探测脚本(单次调用)。
 *
 * macOS 陷阱:未装 Xcode Command Line Tools 时,`/usr/bin/python3` 与 `/usr/bin/git` 只是 stub,
 * **一执行就弹「安装命令行开发者工具」系统对话框**。`command -v` 不会触发,但真调 python3 会。
 * 故 darwin 上若 python3 解析到 /usr/bin 且 `xcode-select -p` 失败,就跳过 python 探测并把
 * git 也从 CLI 清单里剔除——宁可少报,不能在用户没操作时弹系统框。
 */
export function buildProbeScript(): string {
  const modules = PROBED_PYTHON_MODULES.map((m) => `"${m}"`).join(",");
  const python = [
    "import importlib.util,sys",
    'print(sys.version.split()[0])',
    `print(",".join(m for m in [${modules}] if importlib.util.find_spec(m)))`,
  ].join(";");
  const tools = PROBED_CLI_TOOLS.join(" ");
  return [
    `CLT_OK=1`,
    `if [ "$(uname)" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then CLT_OK=0; fi`,
    `echo ${MARK_OS}`,
    `if [ "$(uname)" = Darwin ]; then sw_vers -productVersion 2>/dev/null || echo ${NONE}; else uname -r 2>/dev/null || echo ${NONE}; fi`,
    `echo ${MARK_PY}`,
    `if [ "$CLT_OK" = 0 ] && [ "$(command -v python3)" = /usr/bin/python3 ]; then echo ${NONE};`,
    `else python3 -c '${python}' 2>/dev/null || echo ${NONE}; fi`,
    `echo ${MARK_NODE}`,
    `node --version 2>/dev/null || echo ${NONE}`,
    `echo ${MARK_CLI}`,
    `for c in ${tools}; do`,
    `  if [ "$c" = git ] && [ "$CLT_OK" = 0 ] && [ "$(command -v git)" = /usr/bin/git ]; then continue; fi;`,
    `  command -v "$c" >/dev/null 2>&1 && echo "$c";`,
    `done`,
  ].join("\n");
}

/** 把脚本 stdout 按标记切成段;缺段返回空数组(探测被中断时仍能解析出前面的段)。 */
function splitSections(stdout: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let current: string | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === MARK_OS || line === MARK_PY || line === MARK_NODE || line === MARK_CLI) {
      current = line;
      out[current] = [];
      continue;
    }
    if (current && line) out[current]!.push(line);
  }
  return out;
}

/**
 * 解析探测脚本输出。对每一段独立容错:python 段第一行是版本、第二行是逗号分隔的已装模块;
 * `__NONE__` 表示该运行时不可用。模块 / CLI 只保留探测清单里的名字,防止意外输出混进提示词。
 */
export function parseProbeOutput(
  stdout: string,
  base: Pick<EnvironmentSnapshot, "platform" | "arch" | "shell">,
): EnvironmentSnapshot {
  const sections = splitSections(stdout);
  const os = sections[MARK_OS]?.[0];
  const py = sections[MARK_PY] ?? [];
  const node = sections[MARK_NODE]?.[0];
  const cli = sections[MARK_CLI] ?? [];

  const pythonAvailable = py.length > 0 && py[0] !== NONE;
  const knownModules = new Set<string>(PROBED_PYTHON_MODULES);
  const knownTools = new Set<string>(PROBED_CLI_TOOLS);

  return {
    ...base,
    osVersion: os && os !== NONE ? os : null,
    pythonVersion: pythonAvailable ? py[0]! : null,
    pythonModules: pythonAvailable
      ? (py[1] ?? "")
          .split(",")
          .map((m) => m.trim())
          .filter((m) => knownModules.has(m))
      : [],
    nodeVersion: node && node !== NONE ? node : null,
    cliTools: cli.filter((c) => knownTools.has(c)),
  };
}

/** 人类可读的系统名:darwin → macOS,其余保留 platform 原值。 */
function osLabel(snapshot: EnvironmentSnapshot): string {
  const name = snapshot.platform === "darwin" ? "macOS" : snapshot.platform === "win32" ? "Windows" : snapshot.platform;
  const version = snapshot.osVersion ? ` ${snapshot.osVersion}` : "";
  return `${name}${version} (${snapshot.platform}, ${snapshot.arch})`;
}

/** 列表渲染:空列表写 none,避免出现「Installed modules: 」这种让模型二次猜测的空尾巴。 */
function list(items: readonly string[]): string {
  return items.length ? items.join(", ") : "none";
}

/**
 * 渲染注入系统提示的 <environment> 块(英文,见 CLAUDE.md「系统提示词一律用英文」)。
 *
 * 内容只依赖快照,不带时间戳 / 随机量:同一快照渲染结果逐字节相同,保证供应商 prompt 缓存前缀命中
 *(快照按 probe.ts 的 TTL 才会换,换一次至多丢一次缓存)。
 * 「NOT installed」明确列出,比只列已装更有效——模型盲猜的正是那几个名字,直接点名它们不存在。
 */
export function renderEnvironmentBlock(snapshot: EnvironmentSnapshot): string {
  const installedModules = new Set(snapshot.pythonModules);
  const missingModules = PROBED_PYTHON_MODULES.filter((m) => !installedModules.has(m));
  const installedTools = new Set(snapshot.cliTools);
  const missingTools = PROBED_CLI_TOOLS.filter((t) => !installedTools.has(t));

  const python = snapshot.pythonVersion
    ? `Python: ${snapshot.pythonVersion}. Installed third-party modules: ${list(snapshot.pythonModules)}. NOT installed: ${list(missingModules)}.`
    : "Python: python3 is NOT available.";
  const node = snapshot.nodeVersion ? `Node: ${snapshot.nodeVersion}.` : "Node: NOT available.";

  return [
    "<environment>",
    `OS: ${osLabel(snapshot)}. Shell: ${snapshot.shell}.`,
    python,
    node,
    `CLI tools available: ${list(snapshot.cliTools)}. Not found: ${list(missingTools)}.`,
    "Rules for shell commands:",
    "- Prefer the Python standard library (html.parser, json, csv, re, zipfile, sqlite3, urllib) and the CLI tools listed as available over anything listed as not installed.",
    "- Never assume a module or CLI tool exists unless it is listed above as installed. If unsure, check first (e.g. `python3 -c \"import x\"` or `command -v x`) instead of failing in the real command.",
    "- Do not install packages (pip, npm, brew, etc.) without asking the user first.",
    "- When a command fails, change the approach instead of retrying the same command.",
    "</environment>",
  ].join("\n");
}
