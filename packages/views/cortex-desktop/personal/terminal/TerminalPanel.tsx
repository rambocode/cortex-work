// 个人工作区底部终端（对齐 fanbox：多标签 + 工具栏）。
// 工具栏：标签页 | 启动 Claude / Codex | ＋新终端 | 铺满 | ✕ 收起。
// xterm.js + node-pty;收起面板只隐藏不杀进程;shell 退出后回车原地重开;
// 关闭标签 / 离开个人工作区时真正 kill。

import { useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge, usePersonalStore, type DesktopBridge } from "@cortex-work/core";

const MIN_H = 120;
const MAX_H = 700;

interface XtermLike {
  cols: number;
  rows: number;
  open(el: HTMLElement): void;
  write(data: string): void;
  dispose(): void;
  focus(): void;
  loadAddon(addon: unknown): void;
  onData(cb: (data: string) => void): void;
  onResize(cb: (size: { cols: number; rows: number }) => void): void;
}

interface TermTab {
  id: string;
  title: string;
  dead?: boolean;
  // PTY 已成功 spawn（「发送到终端」只投递给就绪的终端,否则数据会被丢弃）。
  ready?: boolean;
}

let tabSeq = 0;
function newTabId(): string {
  tabSeq += 1;
  return `t-${Date.now().toString(36)}-${tabSeq}`;
}

// fanbox warm 皮肤 ANSI 色板,底色按需求定制为 #FDF9EF。
const WARM_THEME = {
  background: "#FDF9EF",
  foreground: "#4a3f30",
  cursor: "#cc785c",
  cursorAccent: "#FDF9EF",
  selectionBackground: "#cc785c33",
  black: "#3a3025",
  red: "#b5502f",
  green: "#5f7a36",
  yellow: "#9a7b2e",
  blue: "#3a6a8a",
  magenta: "#9a5a7a",
  cyan: "#3a7a70",
  white: "#6b6355",
  brightBlack: "#8a7d68",
  brightRed: "#c75f38",
  brightGreen: "#6f8a40",
  brightYellow: "#b08a30",
  brightBlue: "#4a7a9a",
  brightMagenta: "#aa6a8a",
  brightCyan: "#4a8a82",
  brightWhite: "#3a3025",
};

// 单个终端实例：自管 xterm 生命周期。卸载 = 关标签/离开工作区 → kill PTY。
function TermSession({
  id,
  active,
  cwd,
  bridge,
  onToast,
  onDead,
  onReady,
}: {
  id: string;
  active: boolean;
  cwd?: string;
  bridge: DesktopBridge;
  onToast: (text: string) => void;
  onDead: (id: string, dead: boolean) => void;
  onReady: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XtermLike | null>(null);
  const fitRef = useRef<{ fit(): void } | null>(null);
  const deadRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    const host = hostRef.current;
    if (!host) return;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !hostRef.current) return;

      const mono = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim();
      const xterm = new Terminal({
        fontFamily: mono || "ui-monospace, Menlo, monospace",
        fontSize: 12.5,
        lineHeight: 1.25,
        cursorBlink: true,
        scrollback: 5000,
        // 浅色皮肤下淡色前景自动压暗,保证可读（fanbox/VS Code 同款做法）
        minimumContrastRatio: 4.5,
        theme: WARM_THEME,
      }) as unknown as XtermLike;
      const fit = new FitAddon() as { fit(): void };
      xterm.loadAddon(fit);
      xterm.open(hostRef.current);
      fit.fit();
      xtermRef.current = xterm;
      fitRef.current = fit;

      const spawnPty = async () => {
        deadRef.current = false;
        onDead(id, false);
        const res = await bridge.ptySpawn({ id, cwd, cols: xterm.cols, rows: xterm.rows });
        if (!res.ok) {
          xterm.write(`\r\n\x1b[31m终端启动失败: ${res.error || "未知错误"}\x1b[0m\r\n`);
          onToast(`终端启动失败：${res.error || "未知错误"}`);
          deadRef.current = true;
          onDead(id, true);
          return;
        }
        bridge.ptyResize(id, xterm.cols, xterm.rows);
        onReady(id);
        // 文件预览「发送到终端」:终端刚被唤起时片段先暂存,PTY 就绪后投递。
        const pending = usePersonalStore.getState().consumePendingTerminalText();
        if (pending) bridge.ptyInput(id, pending);
      };

      xterm.onData((data) => {
        if (deadRef.current) {
          if (data === "\r") {
            xterm.write("\r\n");
            void spawnPty();
          }
          return;
        }
        bridge.ptyInput(id, data);
      });
      xterm.onResize(({ cols, rows }) => {
        if (!deadRef.current) bridge.ptyResize(id, cols, rows);
      });

      await spawnPty();
      if (active) xterm.focus();
    })();

    const offData = bridge.onPtyData((pid, data) => {
      if (pid === id) xtermRef.current?.write(data);
    });
    const offExit = bridge.onPtyExit((pid) => {
      if (pid !== id) return;
      deadRef.current = true;
      onDead(id, true);
      xtermRef.current?.write("\r\n\x1b[33m[进程已退出 — 按回车重新打开]\x1b[0m\r\n");
    });

    // 容器尺寸变化（拖高/铺满/开右栏）自动 fit。
    const ro = new ResizeObserver(() => {
      if (host.offsetHeight > 0) fitRef.current?.fit();
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      offData();
      offExit();
      bridge.ptyKill(id);
      xtermRef.current?.dispose();
      xtermRef.current = null;
    };
    // id/bridge 不变;cwd 仅首次 spawn 使用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, bridge]);

  // 激活时聚焦 + fit（display:none → block 后需要重量尺寸）。
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      fitRef.current?.fit();
      xtermRef.current?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [active]);

  return <div className="pw-term-instance" style={{ display: active ? "block" : "none" }} ref={hostRef} />;
}

export function TerminalPanel({ onToast }: { onToast: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const open = usePersonalStore((s) => s.terminalOpen);
  const toggleTerminal = usePersonalStore((s) => s.toggleTerminal);
  const projects = usePersonalStore((s) => s.projects);
  const activeProjectId = usePersonalStore((s) => s.activeProjectId);

  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [height, setHeight] = useState(280);
  const [maximized, setMaximized] = useState(false);
  const cwdRef = useRef<string | undefined>(undefined);

  const activeProject = projects.find((p) => p.id === activeProjectId);
  if (activeProject) cwdRef.current = activeProject.path;

  const addTab = () => {
    const id = newTabId();
    // 标签名 = 目录名（fanbox 风格）,无项目时用 "~"。
    const base = cwdRef.current ? (cwdRef.current.split(/[/\\]/).pop() ?? "~") : "~";
    setTabs((prev) => [...prev, { id, title: base }]);
    setActiveId(id);
  };

  const markDead = (id: string, dead: boolean) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, dead } : t)));
  };

  const markReady = (id: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ready: true } : t)));
  };

  // 文件预览「发送到终端」:激活终端已就绪时直接投递（终端本就开着的场景;
  // 刚唤起的场景由 TermSession spawn 完成后消费,consume 原子防双发）。
  const pendingText = usePersonalStore((s) => s.pendingTerminalText);
  useEffect(() => {
    if (!bridge || !open || !pendingText || !activeId) return;
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab?.ready || tab.dead) return; // 未就绪/已死:留给 spawn 路径投递
    const text = usePersonalStore.getState().consumePendingTerminalText();
    if (text) bridge.ptyInput(activeId, text);
    // tabs 引用频繁变化,以 pendingText/activeId 为主信号即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, open, pendingText, activeId]);

  // 标签名跟随 shell 实时目录（fanbox 风格）:面板可见时每 2.5s 查一次。
  useEffect(() => {
    if (!open || !bridge || tabs.length === 0) return;
    let cancelled = false;
    const refresh = async () => {
      const updates = await Promise.all(
        tabs.map(async (t) => {
          if (t.dead) return null;
          const cwd = await bridge.ptyCwd(t.id).catch(() => null);
          if (!cwd) return null;
          const home = cwd === "/" ? "/" : cwd.replace(/[/\\]+$/, "");
          const base = home.split(/[/\\]/).pop() || "/";
          return { id: t.id, title: base, path: cwd };
        }),
      );
      if (cancelled) return;
      setTabs((prev) =>
        prev.map((t) => {
          const u = updates.find((x) => x && x.id === t.id);
          return u && u.title !== t.title ? { ...t, title: u.title } : t;
        }),
      );
    };
    void refresh();
    const timer = setInterval(refresh, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // tabs 引用每次更新都变,仅以长度/开关为信号,避免无限循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bridge, tabs.length]);

  const closeTab = (id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) setActiveId(next.length > 0 ? next[next.length - 1]!.id : null);
      return next;
    });
  };

  // 首次打开时建第一个标签。
  useEffect(() => {
    if (open && tabs.length === 0) addTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const launchAgent = (cmd: "claude" | "codex") => {
    if (!bridge || !activeId) return;
    bridge.ptyInput(activeId, `${cmd}\r`);
  };

  const onResizeStart = (e: React.MouseEvent) => {
    if (maximized) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (ev: MouseEvent) => {
      setHeight(Math.min(MAX_H, Math.max(MIN_H, startH + (startY - ev.clientY))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (!bridge) return null;

  return (
    <div
      className={`pw-term ${maximized ? "is-max" : ""}`}
      style={{ height: maximized ? undefined : height, display: open ? "flex" : "none" }}
    >
      <div className="pw-term-resizer" onMouseDown={onResizeStart} />
      <div className="pw-term-head">
        <div className="pw-term-tabs">
          {tabs.map((t) => (
            <span
              key={t.id}
              className={`pw-term-tab ${t.id === activeId ? "is-active" : ""}`}
              onClick={() => setActiveId(t.id)}
            >
              <span className={`pw-term-dot ${t.dead ? "is-dead" : ""}`} />
              <Icon.Terminal size={11} />
              {t.title}
              <button
                className="pw-term-tab-x"
                title="关闭终端"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                <Icon.X size={10} />
              </button>
            </span>
          ))}
        </div>
        <div className="pw-term-actions">
          <button className="pw-term-btn agent" title="在当前终端启动 Claude Code" onClick={() => launchAgent("claude")}>
            <Icon.Sparkle size={12} />
            Claude
          </button>
          <button className="pw-term-btn agent" title="在当前终端启动 Codex" onClick={() => launchAgent("codex")}>
            <Icon.Bot size={12} />
            Codex
          </button>
          <button className="pw-term-btn" title="新终端" onClick={addTab}>
            <Icon.Plus size={13} />
          </button>
          <button
            className={`pw-term-btn ${maximized ? "is-on" : ""}`}
            title={maximized ? "还原" : "终端铺满"}
            onClick={() => setMaximized((v) => !v)}
          >
            <Icon.Expand size={12} />
          </button>
          <button className="pw-term-btn" title="收起终端" onClick={toggleTerminal}>
            <Icon.X size={13} />
          </button>
        </div>
      </div>
      <div className="pw-term-host">
        {tabs.map((t) => (
          <TermSession
            key={t.id}
            id={t.id}
            active={t.id === activeId && open}
            cwd={cwdRef.current}
            bridge={bridge}
            onToast={onToast}
            onDead={markDead}
            onReady={markReady}
          />
        ))}
      </div>
    </div>
  );
}
