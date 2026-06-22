// 文件类型图标：扩展名 → 强色徽章/折角文档（借鉴 fanbox 的「10x 识别度」方案,
// 颜色烧死品牌色,一眼认出 TS/GO/PDF）。未命中回退 null,调用方用通用文件图标。

export interface FileIconSpec {
  shape: "badge" | "doc" | "image" | "archive";
  label: string; // 徽章/页面上的短标签
  fontSize: number; // SVG 内文字字号（viewBox 24 坐标系）
  bg: string; // 徽章/页面主体色
  fg: string; // 字色（doc 族固定白字,fg 存折角色）
}

// 代码族：[标签, 字号, 徽章色, 字色]
const CODE_BADGES: Record<string, [string, number, string, string]> = {
  js: ["JS", 8, "#F0DB4F", "#1A1A1A"],
  mjs: ["JS", 8, "#F0DB4F", "#1A1A1A"],
  cjs: ["JS", 8, "#F0DB4F", "#1A1A1A"],
  jsx: ["JSX", 6, "#61DAFB", "#1A1A1A"],
  ts: ["TS", 8, "#3178C6", "#fff"],
  tsx: ["TSX", 6, "#3178C6", "#fff"],
  py: ["PY", 8, "#3776AB", "#FFE05B"],
  go: ["GO", 7.5, "#00ACD7", "#fff"],
  rs: ["RS", 8, "#CE7B43", "#fff"],
  java: ["JV", 8, "#E7700E", "#fff"],
  kt: ["KT", 8, "#A97BFF", "#fff"],
  rb: ["RB", 8, "#CC342D", "#fff"],
  php: ["PHP", 6, "#7A86B8", "#fff"],
  c: ["C", 9, "#5C6BC0", "#fff"],
  h: ["H", 9, "#5C6BC0", "#fff"],
  cpp: ["C++", 6, "#5C6BC0", "#fff"],
  cc: ["C++", 6, "#5C6BC0", "#fff"],
  vue: ["Vue", 6, "#41B883", "#fff"],
  swift: ["SW", 8, "#F05138", "#fff"],
  dart: ["DT", 8, "#0A9EDC", "#fff"],
  lua: ["LUA", 6, "#000080", "#fff"],
  sh: [">_", 8, "#33373D", "#3FD46A"],
  bash: [">_", 8, "#33373D", "#3FD46A"],
  zsh: [">_", 8, "#33373D", "#3FD46A"],
};

// 文档族：[标签, 字号, 主体色, 折角色]
const DOC_TYPES: Record<string, [string, number, string, string]> = {
  pdf: ["PDF", 5, "#E64A3B", "#C23E31"],
  md: ["MD", 7, "#3B82F6", "#2E68C8"],
  markdown: ["MD", 7, "#3B82F6", "#2E68C8"],
  html: ["<>", 7, "#E8662A", "#C4541F"],
  htm: ["<>", 7, "#E8662A", "#C4541F"],
  css: ["CSS", 5, "#2D6FD6", "#2459AC"],
  scss: ["SCSS", 4, "#CF649A", "#A94E7C"],
  less: ["LESS", 4, "#2D5B8A", "#244A70"],
  json: ["{ }", 7, "#A6824C", "#856A3E"],
  json5: ["{ }", 7, "#A6824C", "#856A3E"],
  jsonl: ["{ }", 7, "#A6824C", "#856A3E"],
  yml: ["YML", 5, "#9C5BD6", "#7E49AC"],
  yaml: ["YAML", 4.2, "#9C5BD6", "#7E49AC"],
  toml: ["TOML", 4.2, "#9C5BD6", "#7E49AC"],
  xml: ["XML", 5, "#5E8A3E", "#4A6E31"],
  svg: ["SVG", 5, "#E8923A", "#C4761F"],
  csv: ["CSV", 5, "#1FAE5A", "#188F4A"],
  tsv: ["TSV", 5, "#1FAE5A", "#188F4A"],
  sql: ["SQL", 5, "#C77D2E", "#A4661F"],
  doc: ["DOC", 5, "#2B579A", "#21457A"],
  docx: ["DOC", 5, "#2B579A", "#21457A"],
  xls: ["XLS", 5, "#1D6F42", "#155632"],
  xlsx: ["XLS", 5, "#1D6F42", "#155632"],
  ppt: ["PPT", 5, "#C43E1C", "#9E3216"],
  pptx: ["PPT", 5, "#C43E1C", "#9E3216"],
  log: ["LOG", 5, "#7A8290", "#626977"],
  txt: ["TXT", 5, "#7A8290", "#626977"],
  lock: ["LOCK", 4.2, "#7A8290", "#626977"],
  ini: ["INI", 5, "#9C5BD6", "#7E49AC"],
  conf: ["CONF", 4.2, "#9C5BD6", "#7E49AC"],
  env: ["ENV", 5, "#A6824C", "#856A3E"],
};

// 无扩展名/全名特殊文件 → 复用代码徽章形
const FULLNAME_BADGES: Record<string, [string, number, string, string]> = {
  dockerfile: ["DK", 8, "#2496ED", "#fff"],
  makefile: ["MK", 8, "#6D8086", "#fff"],
  "go.mod": ["GO", 7.5, "#00ACD7", "#fff"],
  "go.sum": ["GO", 7.5, "#00ACD7", "#fff"],
  license: ["LIC", 6, "#7A8290", "#fff"],
};

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "ico", "icns", "bmp", "tiff"]);
const ARCHIVE_EXT = new Set(["zip", "rar", "7z", "gz", "tar", "tgz", "bz2", "xz", "dmg"]);
const MEDIA_EXT = new Set(["mp4", "mov", "webm", "mkv", "avi", "mp3", "wav", "m4a", "flac", "ogg"]);
// 文档/二进制类:内置 Monaco 文本编辑器打不开(强转 UTF-8 会乱码),应交给系统默认应用打开。
// 与 IMAGE/ARCHIVE/MEDIA 区分:这些仍能在文件树显示文档徽章,但点击走系统 open 而非内置预览。
const DOC_BINARY_EXT = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "odt", "ods", "odp", "rtf", "pages", "numbers", "key",
  "sqlite", "sqlite3", "db",
  "exe", "dll", "so", "dylib", "bin", "dat",
  "ttf", "otf", "woff", "woff2",
  "psd", "ai", "sketch", "fig",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function fileIconSpec(name: string): FileIconSpec | null {
  const full = name.toLowerCase();
  const fullHit = FULLNAME_BADGES[full];
  if (fullHit) return { shape: "badge", label: fullHit[0], fontSize: fullHit[1], bg: fullHit[2], fg: fullHit[3] };
  const ex = extOf(name);
  if (!ex) return null;
  const code = CODE_BADGES[ex];
  if (code) return { shape: "badge", label: code[0], fontSize: code[1], bg: code[2], fg: code[3] };
  const doc = DOC_TYPES[ex];
  if (doc) return { shape: "doc", label: doc[0], fontSize: doc[1], bg: doc[2], fg: doc[3] };
  if (IMAGE_EXT.has(ex)) return { shape: "image", label: "", fontSize: 0, bg: "#2BB6A3", fg: "#fff" };
  if (ARCHIVE_EXT.has(ex) || MEDIA_EXT.has(ex))
    return { shape: "archive", label: "", fontSize: 0, bg: "#E0A23B", fg: "#fff" };
  return null;
}

// 二进制类文件（图片/压缩包/媒体）不进 Monaco 文本预览。仅用于文件树拖拽门控。
export function isBinaryLike(name: string): boolean {
  const ex = extOf(name);
  return IMAGE_EXT.has(ex) || ARCHIVE_EXT.has(ex) || MEDIA_EXT.has(ex);
}

// 内置编辑器打不开、应交系统默认应用打开的文件:图片/压缩/媒体 + office 文档/pdf/二进制。
// 点击此类文件链接(会话内或文件树)直接调 bridge.openPath,不进右栏内置预览。
export function isOpenExternalLike(name: string): boolean {
  return isBinaryLike(name) || DOC_BINARY_EXT.has(extOf(name));
}

// 文件树行内小图标。spec 为 null 时由调用方回退通用 <Icon.File>。
export function FileIcon({ name, size = 13 }: { name: string; size?: number }) {
  const spec = fileIconSpec(name);
  if (!spec) return null;
  if (spec.shape === "doc") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M5 3.6A1.6 1.6 0 0 1 6.6 2H14l5 5v11.4A1.6 1.6 0 0 1 17.4 20H6.6A1.6 1.6 0 0 1 5 18.4z" fill={spec.bg} />
        <path d="M14 2l5 5h-3.4A1.6 1.6 0 0 1 14 5.4z" fill={spec.fg} />
        <text
          x="11.6" y="16.6" textAnchor="middle" fontWeight="800"
          fontSize={spec.fontSize * 1.4} fill="#fff"
          fontFamily="-apple-system,'Helvetica Neue',Arial,sans-serif"
        >
          {spec.label}
        </text>
      </svg>
    );
  }
  if (spec.shape === "image") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="3" y="3" width="18" height="18" rx="5" fill={spec.bg} />
        <circle cx="9" cy="9.5" r="1.6" fill="#fff" />
        <path d="M5 16l3.5-3.5 2.5 2.5L14.5 11 19 16z" fill="#fff" />
      </svg>
    );
  }
  if (spec.shape === "archive") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="4" y="3.5" width="16" height="17" rx="2.2" fill={spec.bg} />
        <rect x="10.6" y="3.5" width="2.8" height="17" fill="#C8862A" />
        <rect x="10.6" y="8" width="2.8" height="3" rx="0.5" fill="#fff8e6" />
        <rect x="11.4" y="11" width="1.2" height="3.4" rx="0.6" fill="#fff8e6" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="5" fill={spec.bg} />
      <text
        x="12" y="15.7" textAnchor="middle" fontWeight="800"
        fontSize={spec.fontSize * 1.4} fill={spec.fg}
        fontFamily="-apple-system,'Helvetica Neue',Arial,sans-serif"
      >
        {spec.label}
      </text>
    </svg>
  );
}
