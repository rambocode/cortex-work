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
  Edit: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M4 20h4l10-10-4-4L4 16v4z" />
      <path d="M14 6l4 4" />
    </IconBase>
  ),
  Search: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-3.5-3.5" />
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
};

export type IconName = keyof typeof Icon;
