// 文件名 → Monaco language id（借鉴 fanbox mona.lang）。纯字符串映射,
// 不 import monaco（views 同时被 Next.js 打包,monaco 只能动态加载）。

const LANG_BY_EXT: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  json5: "json",
  jsonc: "json",
  jsonl: "json",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  vue: "html",
  css: "css",
  scss: "scss",
  less: "less",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  php: "php",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  h: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  env: "ini",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  swift: "swift",
  lua: "lua",
  kt: "kotlin",
  dart: "dart",
  r: "r",
};

const LANG_BY_FULLNAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "shell",
};

export function langForName(name: string): string {
  const full = name.toLowerCase();
  if (LANG_BY_FULLNAME[full]) return LANG_BY_FULLNAME[full];
  const i = name.lastIndexOf(".");
  const ex = i > 0 ? name.slice(i + 1).toLowerCase() : "";
  return LANG_BY_EXT[ex] ?? "plaintext";
}

// 散文类默认软换行,代码不换行（fanbox 同款）。
export function wordWrapForName(name: string): boolean {
  const i = name.lastIndexOf(".");
  const ex = i > 0 ? name.slice(i + 1).toLowerCase() : "";
  return ["md", "markdown", "txt", "log"].includes(ex);
}
