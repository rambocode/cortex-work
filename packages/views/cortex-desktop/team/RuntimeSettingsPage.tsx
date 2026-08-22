// 设置页「Runtimes」分区：服务器执行节点与服务器工作区管理。
// live（已登录真实后端）: 左栏 = daemon 机器分组（真实 /api/server-workspaces 的 runtimes 映射），
// 右栏 = 选中机器的服务器工作区列表 + 新建（共享/独立）。demo（未接后端）: 保留原静态展示壳。
// 数据全走 React Query（serverWorkspaceKeys, 含 wsId 命名空间）；占用/排队摘要由
// server_workspace:queue 事件驱动失效后自动刷新。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  createServerWorkspaceErrorKey,
  pickRuntime,
  useCreateServerWorkspace,
  useDeleteServerWorkspace,
  useServerWorkspaces,
  workspaceOccupancy,
  type ServerWorkspaceGroup,
} from "@cortex-work/core";
import { useCoreContext } from "@cortex-work/core";
import type { ServerWorkspace, ServerWorkspaceMode } from "@cortex-work/core/api/types";
import { ServerDirectoryBrowser } from "./ServerDirectoryBrowser";

export function RuntimeSettingsPage({ onToast }: { onToast?: (text: string) => void }) {
  const { liveDataEnabled } = useCoreContext();
  if (!liveDataEnabled) return <DemoRuntimeSettings />;
  return <LiveRuntimeSettings onToast={onToast} />;
}

// ── live：真实服务器/工作区 ─────────────────────────────────────────────────

function LiveRuntimeSettings({ onToast }: { onToast?: (text: string) => void }) {
  const { t } = useTranslation();
  const { identity } = useCoreContext();
  const { data, isLoading } = useServerWorkspaces();
  const groups = data?.groups ?? [];
  const [activeDaemon, setActiveDaemon] = useState<string | null>(null);
  const active = groups.find((g) => g.daemonId === activeDaemon) ?? groups[0];

  return (
    <section className="settings-full-panel runtime-aligned">
      <div className="aligned-page-header">
        <div>
          <Icon.Terminal size={15} />
          <h1>{t("serverWs.title")}</h1>
          <span>{groups.length}</span>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="serverws-empty-hint">{isLoading ? t("loading") : t("serverWs.noMachines")}</div>
      ) : (
        <div className="runtime-split">
          <aside className="runtime-machine-pane">
            <div className="machine-section-label">
              <span>{t("serverWs.machines")}</span>
              <i />
            </div>
            {groups.map((g) => (
              <button
                key={g.daemonId}
                className={`machine-row ${active?.daemonId === g.daemonId ? "is-active" : ""}`}
                onClick={() => setActiveDaemon(g.daemonId)}
              >
                <span className="machine-icon">
                  <Icon.Globe size={14} />
                  <i className={g.online ? "green" : "amber"} />
                </span>
                <span>
                  <b>{g.label}</b>
                  <small>{g.online ? t("serverWs.online") : t("serverWs.offline")}</small>
                </span>
                <em>{t("serverWs.workspaceCount", { n: g.workspaces.length })}</em>
              </button>
            ))}
          </aside>
          {active ? <MachineDetail group={active} myUserId={identity.userId} onToast={onToast} /> : null}
        </div>
      )}
    </section>
  );
}

function MachineDetail({
  group,
  myUserId,
  onToast,
}: {
  group: ServerWorkspaceGroup;
  myUserId: string;
  onToast?: (text: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <main className="runtime-detail-pane">
      <div className="runtime-detail-head">
        <span className="runtime-detail-icon">
          <Icon.Globe size={18} />
        </span>
        <div>
          <h2>{group.label}</h2>
          <p>
            <span className={`mini-dot ${group.online ? "green" : "amber"}`} />
            {group.online ? t("serverWs.online") : t("serverWs.offline")}
            {" · "}
            {group.runtimes.map((r) => r.name).join(", ")}
          </p>
        </div>
      </div>

      <div className="runtime-runtime-list">
        <h3>{t("serverWs.workspaces")}</h3>
        {group.workspaces.length === 0 ? (
          <div className="serverws-empty-hint">{t("serverWs.empty")}</div>
        ) : (
          group.workspaces.map((sw) => (
            <WorkspaceRow key={sw.id} sw={sw} myUserId={myUserId} onToast={onToast} />
          ))
        )}
      </div>

      <CreateWorkspaceForm group={group} onToast={onToast} />
    </main>
  );
}

function WorkspaceRow({ sw, myUserId, onToast }: { sw: ServerWorkspace; myUserId: string; onToast?: (text: string) => void }) {
  const { t } = useTranslation();
  const del = useDeleteServerWorkspace();
  // 删除是不可逆动作（daemon 收到 sync 后清盘），二次点击确认。
  const [armed, setArmed] = useState(false);

  const occupancy = workspaceOccupancy(sw, myUserId);
  const statusText =
    sw.status === "provisioning"
      ? t("serverWs.statusProvisioning")
      : sw.status === "error"
        ? `${t("serverWs.statusError")}${sw.status_detail ? ` · ${sw.status_detail}` : ""}`
        : occupancy === "occupied"
          ? `${t("serverWs.occupiedBy")}${sw.queue_depth ? ` · ${t("serverWs.queueDepth", { n: sw.queue_depth })}` : ""}`
          : occupancy === "mine"
            ? t("serverWs.mine")
            : t("serverWs.free");

  return (
    <div className="runtime-runtime-row serverws-row">
      <span>
        <Icon.Folder size={14} />
        {sw.name}
        <em className={`serverws-mode-badge is-${sw.mode}`}>
          {sw.mode === "shared" ? t("serverWs.badgeShared") : t("serverWs.badgeIsolated")}
        </em>
      </span>
      <b className={sw.status === "error" ? "serverws-status-error" : undefined}>{statusText}</b>
      <button
        className="icon-btn serverws-del"
        title={armed ? t("serverWs.deleteConfirm") : t("serverWs.delete")}
        onClick={() => {
          if (!armed) {
            setArmed(true);
            window.setTimeout(() => setArmed(false), 2500);
            return;
          }
          del.mutate(sw.id, {
            onError: () => onToast?.(t("serverWs.errDeleteFailed")),
          });
        }}
      >
        <Icon.Trash size={13} />
      </button>
    </div>
  );
}

function CreateWorkspaceForm({ group, onToast }: { group: ServerWorkspaceGroup; onToast?: (text: string) => void }) {
  const { t } = useTranslation();
  const create = useCreateServerWorkspace();
  const [name, setName] = useState("");
  // 两种来源：dir = 服务器上已有目录（默认，免 clone）；git = 仓库地址 clone。
  const [source, setSource] = useState<"dir" | "git">("dir");
  const [repoUrl, setRepoUrl] = useState("");
  const [dirPath, setDirPath] = useState("");
  const [branch, setBranch] = useState("");
  const [mode, setMode] = useState<ServerWorkspaceMode>("shared");
  const [browserOpen, setBrowserOpen] = useState(false);
  const runtime = pickRuntime(group);
  const sourceFilled = source === "git" ? !!repoUrl.trim() : !!dirPath.trim();
  const canSubmit = !!name.trim() && sourceFilled && !!runtime && !create.isPending;

  return (
    <div className="serverws-create">
      <h3>{t("serverWs.newWorkspace")}</h3>
      <div className="serverws-create-grid">
        <input
          className="pw-input"
          placeholder={t("serverWs.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="serverws-mode-pick" role="radiogroup" aria-label={t("serverWs.sourceLabel")}>
          <button className={`mc-chip ${source === "dir" ? "is-active" : ""}`} onClick={() => setSource("dir")}>
            {t("serverWs.sourceDir")}
          </button>
          <button className={`mc-chip ${source === "git" ? "is-active" : ""}`} onClick={() => setSource("git")}>
            {t("serverWs.sourceGit")}
          </button>
        </div>
        {source === "git" ? (
          <>
            <input
              className="pw-input"
              placeholder={t("serverWs.repoUrl")}
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
            <input
              className="pw-input"
              placeholder={t("serverWs.branch")}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </>
        ) : (
          <div className="serverws-dir-row">
            <input
              className="pw-input"
              placeholder={t("serverWs.dirPath")}
              value={dirPath}
              onChange={(e) => setDirPath(e.target.value)}
            />
            <button className="mc-chip" onClick={() => setBrowserOpen(true)} disabled={!runtime}>
              <Icon.Folder size={13} />
              {t("serverWs.browse")}
            </button>
            {browserOpen && runtime ? (
              <ServerDirectoryBrowser
                runtimeId={runtime.id}
                initialPath={dirPath.trim() || undefined}
                onPick={(p) => setDirPath(p)}
                onClose={() => setBrowserOpen(false)}
              />
            ) : null}
          </div>
        )}
        <div className="serverws-mode-pick" role="radiogroup">
          <button className={`mc-chip ${mode === "shared" ? "is-active" : ""}`} onClick={() => setMode("shared")}>
            {t("serverWs.modeShared")}
          </button>
          {/* 目录模式无法做 per-member worktree 隔离 → 独立选项禁用并提示。 */}
          <button
            className={`mc-chip ${mode === "isolated" ? "is-active" : ""}`}
            disabled={source === "dir"}
            title={source === "dir" ? t("serverWs.dirIsolatedHint") : undefined}
            onClick={() => setMode("isolated")}
          >
            {t("serverWs.modeIsolated")}
          </button>
        </div>
      </div>
      <button
        className="mc-primary-btn"
        disabled={!canSubmit}
        onClick={() =>
          create.mutate(
            {
              name: name.trim(),
              repo_url: source === "git" ? repoUrl.trim() : undefined,
              path: source === "dir" ? dirPath.trim() : undefined,
              branch: source === "git" ? branch.trim() || undefined : undefined,
              // 目录模式强制 shared（独立选项已禁用，此处兜底）。
              mode: source === "dir" ? "shared" : mode,
              runtime_id: runtime!.id,
            },
            {
              onSuccess: () => {
                setName("");
                setRepoUrl("");
                setDirPath("");
                setBranch("");
                onToast?.(t("serverWs.created"));
              },
              onError: (err) => onToast?.(t(createServerWorkspaceErrorKey(err))),
            },
          )
        }
      >
        <Icon.Plus size={14} />
        {create.isPending ? t("serverWs.creating") : t("serverWs.create")}
      </button>
    </div>
  );
}

// ── demo：未接真实后端时的静态展示壳（自原 Sections.tsx RuntimeSettings 原样迁入） ──

function DemoRuntimeSettings() {
  const machines = [
    { id: "local", title: "MacBook-Pro.local", subtitle: "daemon local-codex-mbp", section: "Local", health: "online", runtimes: 2, busy: 0 },
    { id: "remote", title: "Build Runner", subtitle: "remote ssh runtime", section: "Remote", health: "issues", runtimes: 1, busy: 1 },
  ];
  return (
    <section className="settings-full-panel runtime-aligned">
      <div className="aligned-page-header">
        <div>
          <Icon.Terminal size={15} />
          <h1>Runtimes</h1>
          <span>3</span>
        </div>
        <button className="mc-primary-btn"><Icon.Plus size={14} />Connect Remote</button>
      </div>

      <div className="runtime-split">
        <aside className="runtime-machine-pane">
          <div className="runtime-machine-toolbar">
            <label className="mc-searchbox"><Icon.Search size={14} /><input placeholder="Search machines..." readOnly /></label>
            <div className="mc-chip-group">
              <button className="mc-chip is-active">All 2</button>
              <button className="mc-chip"><span className="mini-dot green" />Online 1</button>
              <button className="mc-chip"><span className="mini-dot amber" />Issues 1</button>
            </div>
          </div>
          <div className="machine-section-label"><span>Local</span><i /></div>
          {machines.filter((m) => m.section === "Local").map((machine) => (
            <button key={machine.id} className="machine-row is-active">
              <span className="machine-icon"><Icon.Terminal size={14} /><i className="green" /></span>
              <span>
                <b>{machine.title}</b>
                <small>{machine.subtitle}</small>
              </span>
              <em>{machine.runtimes} runtimes</em>
            </button>
          ))}
          <div className="machine-section-label"><span>Remote</span><i /></div>
          {machines.filter((m) => m.section === "Remote").map((machine) => (
            <button key={machine.id} className="machine-row">
              <span className="machine-icon"><Icon.Globe size={14} /><i className="amber" /></span>
              <span>
                <b>{machine.title}</b>
                <small>{machine.subtitle}</small>
              </span>
              <em>{machine.busy} busy</em>
            </button>
          ))}
        </aside>
        <main className="runtime-detail-pane">
          <div className="runtime-detail-head">
            <span className="runtime-detail-icon"><Icon.Terminal size={18} /></span>
            <div>
              <h2>MacBook-Pro.local</h2>
              <p><span className="mini-dot green" />Healthy · This machine</p>
            </div>
          </div>
          <div className="runtime-detail-grid">
            <div className="runtime-detail-card"><span>Providers</span><b>Codex, OpenAI</b></div>
            <div className="runtime-detail-card"><span>Queued</span><b>0</b></div>
            <div className="runtime-detail-card"><span>Running</span><b>0</b></div>
            <div className="runtime-detail-card"><span>Version</span><b>v2.14.0</b></div>
          </div>
          <div className="runtime-runtime-list">
            <h3>Runtimes on this machine</h3>
            {["Codex", "OpenAI Responses"].map((name) => (
              <div key={name} className="runtime-runtime-row">
                <span><Icon.Bot size={14} />{name}</span>
                <b>Idle</b>
              </div>
            ))}
          </div>
        </main>
      </div>
    </section>
  );
}
