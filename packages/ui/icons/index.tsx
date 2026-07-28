// Tiny inline SVG icons (stroke-based, Codex-style).
// Each icon is a React component accepting { size, sw }.
import type { SVGProps, ReactNode } from "react";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: number;
  sw?: number;
}

function IconBase({ size = 16, sw = 1.7, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, display: "block" }}
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Icon = {
  // ── 工作流节点专属图标（对应 25 种节点 kind）────────────────────────────────
  // Hand：手动触发节点（手形，代表「人工启动」）
  Hand: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M18 11V7a2 2 0 0 0-4 0v1" />
      <path d="M14 8V5a2 2 0 0 0-4 0v3" />
      <path d="M10 8.5V5a2 2 0 0 0-4 0v5" />
      <path d="M6 10v4a6 6 0 0 0 12 0v-3" />
    </IconBase>
  ),
  // Webhook：Webhook 触发节点（网络钩子，箭头 + 连接点）
  Webhook: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
      <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
      <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
    </IconBase>
  ),
  // Split：分支（Switch）节点（一路变多路）
  Split: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M16 3h5v5" />
      <path d="M8 3H3v5" />
      <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3" />
      <path d="m15 9 6-6" />
    </IconBase>
  ),
  // Filter：过滤节点（漏斗形状）
  Filter: (p: IconProps) => (
    <IconBase {...p}>
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </IconBase>
  ),
  // Sort：排序节点（上下双箭头）
  Sort: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M3 16l4 4 4-4" />
      <path d="M7 20V4" />
      <path d="M21 8l-4-4-4 4" />
      <path d="M17 4v16" />
    </IconBase>
  ),
  // Scissors：截取（Limit）节点（剪刀）
  Scissors: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4L8.12 15.88M14.47 14.48L20 20" />
      <path d="M8.12 8.12L12 12" />
    </IconBase>
  ),
  // Sigma：聚合（Aggregate）节点（Σ 求和符号）
  Sigma: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M18 7V4H6l6 8-6 8h12v-3" />
    </IconBase>
  ),
  // Merge：合并（Merge）节点（GitMerge 语义，多路汇聚）
  Merge: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </IconBase>
  ),
  // Type：模板（Template）节点（文字/字体标识）
  Type: (p: IconProps) => (
    <IconBase {...p}>
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </IconBase>
  ),
  // LogOut：输出（Output）节点（退出/导出箭头）
  LogOut: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </IconBase>
  ),
  // Tags：问题分类（QuestionClassifier）节点（多标签）
  Tags: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M9 5H2v7l6.29 6.29c.94.94 2.48.94 3.42 0l3.58-3.58c.94-.94.94-2.48 0-3.42L9 5Z" />
      <path d="M6 9.01V9" />
      <path d="m15 5 6.3 6.3a2.4 2.4 0 0 1 0 3.4L17 19" />
    </IconBase>
  ),
  // Save：保存按钮（软盘形状）
  Save: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
      <path d="M7 3v4a1 1 0 0 0 1 1h7" />
    </IconBase>
  ),
  // Variable：环境变量按钮（花括号 + $）
  Variable: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" />
      <path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
    </IconBase>
  ),
  // MousePointer：画布空态提示图标（光标点击）
  MousePointer: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M4 4l7.07 17 2.51-7.39L21 11.07z" />
    </IconBase>
  ),
  // ChevronLeft：左折叠箭头（sidebar 折叠按钮）
  ChevronLeft: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M15 6l-6 6 6 6" />
    </IconBase>
  ),
  Sidebar: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </IconBase>
  ),
  Back: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M15 6l-6 6 6 6" />
    </IconBase>
  ),
  Fwd: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M9 6l6 6-6 6" />
    </IconBase>
  ),
  // ArrowDownRight：斜向下箭头（↘）。落地页场景示例用它指向下方的输入框，暗示「点了会填到那里」。
  ArrowDownRight: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M7 7l10 10" />
      <path d="M17 9v8h-8" />
    </IconBase>
  ),
  // ArrowUp：正向上箭头（↑）。composer 圆形发送按钮专用，区别于右向的 Send（后者用于「发送到 Chat」等菜单语义）。
  ArrowUp: (p: IconProps) => (
    <IconBase {...p} sw={p?.sw ?? 2}>
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </IconBase>
  ),
  Run: (p: IconProps) => (
    <IconBase {...p}>
      <polygon points="7 5 19 12 7 19 7 5" />
    </IconBase>
  ),
  Terminal: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M4 5h16v14H4z" />
      <path d="M7 9l3 3-3 3" />
      <path d="M13 15h4" />
    </IconBase>
  ),
  Info: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8h.01M11 12h1v4h1" />
    </IconBase>
  ),
  // AlertCircle：圆圈感叹号（警示态,如「完全访问」权限档）
  AlertCircle: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </IconBase>
  ),
  More: (p: IconProps) => (
    <IconBase {...p} sw={p?.sw ?? 2.4}>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </IconBase>
  ),
  Expand: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M4 9V4h5" />
      <path d="M20 9V4h-5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
    </IconBase>
  ),
  // 放大:对角两个角标(右上 + 左下),不画箭头。
  Maximize: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M14 4h6v6" />
      <path d="M10 20H4v-6" />
    </IconBase>
  ),
  // 还原:Maximize 的反向 —— 角标开口朝外 + 连到画布角落的对角线,合起来是两支相向的箭头。
  Minimize: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M20 10h-6V4" />
      <path d="M14 10 21 3" />
      <path d="M4 14h6v6" />
      <path d="m3 21 7-7" />
    </IconBase>
  ),
  Edit: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M4 20h4l10-10-4-4L4 16v4z" />
      <path d="M14 6l4 4" />
    </IconBase>
  ),
  Retry: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 4v5h-5" />
    </IconBase>
  ),
  Copy: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
    </IconBase>
  ),
  Search: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-3.5-3.5" />
    </IconBase>
  ),
  // 下载/导出:向下箭头 + 底托,用于自动化「导出运行历史」。
  Download: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 4v11" />
      <path d="M8 11l4 4 4-4" />
      <path d="M5 19h14" />
    </IconBase>
  ),
  Clock: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </IconBase>
  ),
  FolderPlus: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      <path d="M12 11v6" />
      <path d="M9 14h6" />
    </IconBase>
  ),
  Stop: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </IconBase>
  ),
  Folder: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </IconBase>
  ),
  Settings: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09c0 .69.4 1.31 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.25.63.87 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z" />
    </IconBase>
  ),
  Chevron: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M6 9l6 6 6-6" />
    </IconBase>
  ),
  ChevronRight: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M9 6l6 6-6 6" />
    </IconBase>
  ),
  Pin: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 2l3 6 5 1-4 4 1 5-5-3-5 3 1-5-4-4 5-1 3-6z" />
    </IconBase>
  ),
  At: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </IconBase>
  ),
  Check: (p: IconProps) => (
    <IconBase {...p} sw={p?.sw ?? 2}>
      <path d="M4 12l5 5L20 6" />
    </IconBase>
  ),
  CheckCircle: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12l3 3 5-5" />
    </IconBase>
  ),
  // Circle：空心圆（任务「活动 / 未开始」状态标识，圆形状态族之首）
  Circle: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="12" cy="12" r="9" />
    </IconBase>
  ),
  // CircleDot：带实心圆心的圆（任务「进行中」状态标识，与空心圆区分「已开始」）
  CircleDot: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
    </IconBase>
  ),
  X: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </IconBase>
  ),
  XCircle: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </IconBase>
  ),
  Plus: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </IconBase>
  ),
  // 归档盒:顶盖 + 盒体 + 中间把手横线
  Archive: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </IconBase>
  ),
  // 垃圾桶:盖 + 桶体 + 两道竖纹
  Trash: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
      <path d="M10 11v5M14 11v5" />
    </IconBase>
  ),
  Paperclip: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M21 12.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" />
    </IconBase>
  ),
  Image: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M21 16l-5-5L5 21" />
    </IconBase>
  ),
  // 截图(相机轮廓 + 镜头);内嵌浏览器工具栏「截图到剪贴板」用。
  Camera: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M14.5 4l1.5 2H20a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4l1.5-2z" />
      <circle cx="12" cy="13" r="3" />
    </IconBase>
  ),
  // 评论/标注气泡;内嵌浏览器工具栏「页面元素标注」用。
  Comment: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M21 11.5a8 8 0 0 1-11.5 7.2L4 20.5l1.8-4.8A8 8 0 1 1 21 11.5z" />
    </IconBase>
  ),
  Mic: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </IconBase>
  ),
  Send: (p: IconProps) => (
    <IconBase {...p} sw={p?.sw ?? 2}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </IconBase>
  ),
  Lightning: (p: IconProps) => (
    <IconBase {...p} sw={p?.sw ?? 1.6}>
      <polygon points="13 2 4 14 11 14 10 22 20 9 13 9 13 2" />
    </IconBase>
  ),
  // Power：电源开关（节点启用/禁用切换）。
  Power: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </IconBase>
  ),
  Code: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M8 7l-5 5 5 5" />
      <path d="M16 7l5 5-5 5" />
    </IconBase>
  ),
  File: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </IconBase>
  ),
  // StickyNote：便签节点（折角便签卡片）。
  StickyNote: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8l7-7V5a2 2 0 0 0-2-2z" />
      <path d="M14 21v-5a2 2 0 0 1 2-2h5" />
    </IconBase>
  ),
  // Palette：调色板（便签改色）。
  Palette: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 21a9 9 0 1 1 0-18c4.97 0 9 3.58 9 8 0 2.5-2 4-4 4h-2a2 2 0 0 0-1.5 3.3A1.5 1.5 0 0 1 12 21z" />
      <circle cx="7.5" cy="11" r="1" />
      <circle cx="12" cy="7.5" r="1" />
      <circle cx="16" cy="11" r="1" />
    </IconBase>
  ),
  Reply: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 5 5v6" />
    </IconBase>
  ),
  Share: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="6" cy="12" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M8 11l8-4M8 13l8 4" />
    </IconBase>
  ),
  Bell: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9z" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </IconBase>
  ),
  Sparkle: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M5 12H1" />
      <path d="M23 12h-4" />
      <path d="M7 7l3 3" />
      <path d="M14 14l3 3" />
      <path d="M7 17l3-3" />
      <path d="M14 10l3-3" />
    </IconBase>
  ),
  Hashtag: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M4 9h16" />
      <path d="M4 15h16" />
      <path d="M10 3L8 21" />
      <path d="M16 3l-2 18" />
    </IconBase>
  ),
  Users: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="9" cy="9" r="3" />
      <path d="M3 19a6 6 0 0 1 12 0" />
      <circle cx="17" cy="8" r="2.5" />
      <path d="M15 19a5 5 0 0 1 6-4" />
    </IconBase>
  ),
  Globe: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </IconBase>
  ),
  Workflow: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="3" width="6" height="6" rx="1" />
      <rect x="9" y="15" width="6" height="6" rx="1" />
      <path d="M6 9v3h12V9" />
      <path d="M12 12v3" />
    </IconBase>
  ),
  GitBranch: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </IconBase>
  ),
  Diff: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M5 4v10a3 3 0 0 0 3 3h5" />
      <path d="M19 20V10a3 3 0 0 0-3-3h-5" />
      <path d="M10 4L13 7l-3 3" />
      <path d="M14 17l-3 3 3 3" />
    </IconBase>
  ),
  Task: (p: IconProps) => (
    <IconBase {...p}>
      <rect x="3" y="4" width="7" height="7" rx="1.5" />
      <path d="M4.5 7.5l1.5 1.5 2.5-3" />
      <path d="M14 6h7" />
      <path d="M14 12h7" />
      <path d="M14 18h7" />
      <path d="M3.5 16.5l1.8 1.8 3.2-3.6" />
    </IconBase>
  ),
  Bot: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 8V4H8" />
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M9 13v2" />
      <path d="M15 13v2" />
    </IconBase>
  ),
  Chart: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M3 3v18h18" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </IconBase>
  ),
  // U15 新增：导入（Upload）、密钥显示/隐藏（Eye/EyeOff）
  Upload: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </IconBase>
  ),
  Eye: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </IconBase>
  ),
  EyeOff: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </IconBase>
  ),
};

export type IconName = keyof typeof Icon;
