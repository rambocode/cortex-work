// 创建/编辑自动化弹窗。复用居中模态外壳样式（pw-dlg-overlay/pw-dlg/
// pw-dlg-x）+ pw-set-field 表单原语 + SegmentedRadio。agent↔model 联动:切 agent
// 重置 model;pi 走 `${channelId}::${modelId}` 编码（复刻 PersonalComposer）,无可用
// 通道时禁用提交。推理强度三档（pi 不支持,附提示,执行时由 main 忽略）。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { SegmentedRadio } from "@cortex-work/ui/controls/SegmentedRadio";
import {
  AGENT_MODELS,
  DEFAULT_MODEL,
  useCreateAutomation,
  useUpdateAutomation,
  usePersonalStore,
} from "@cortex-work/core";
import { enabledPushTargets } from "@cortex-work/core/personal/push";
import type {
  AgentKind,
  AutomationInput,
  AutomationMeta,
  PushChannelKind,
  ReasoningEffort,
  ScheduleSpec,
} from "@cortex-work/core";
import { ScheduleEditor } from "./ScheduleEditor";
import { ModelRefField } from "../settings/provider/ModelRefField";

const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };
const EFFORT_LABEL: Record<ReasoningEffort, string> = { low: "低", medium: "中", high: "高" };
const EFFORT_ORDER: ReasoningEffort[] = ["low", "medium", "high"];
const effortToLabel = (e: ReasoningEffort) => EFFORT_LABEL[e];
const labelToEffort = (l: string): ReasoningEffort => EFFORT_ORDER.find((e) => EFFORT_LABEL[e] === l) ?? "medium";

function Select({
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="pw-set-field">
      <span className="pw-set-lbl">{label}</span>
      <select
        className="pw-set-input"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <span className="pw-set-hint">{hint}</span> : null}
    </label>
  );
}

export function AutomationDialog({
  meta,
  initial,
  onClose,
  onToast,
}: {
  meta?: AutomationMeta; // 传入 = 编辑;否则新建
  // 模板预填:仅新建时生效（不带 id,仍走 create）。优先级 meta > initial > 空默认;
  // agent / model / providerId 不受其影响,仍按现有 agent 兜底与联动逻辑（见 KTD-2）。
  initial?: Partial<AutomationInput>;
  onClose: () => void;
  onToast: (text: string) => void;
}) {
  const editing = !!meta;
  const projects = usePersonalStore((s) => s.projects);
  const pushSettings = usePersonalStore((s) => s.pushSettings);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const create = useCreateAutomation();
  const update = useUpdateAutomation();
  const saving = create.isPending || update.isPending;

  const availAgents = (Object.keys(AGENT_MODELS) as AgentKind[]).filter(
    (a) => a === "pi" || agentsAvailable?.[a],
  );
  const initialAgent: AgentKind = meta?.agent ?? availAgents[0] ?? "pi";

  const [name, setName] = useState(meta?.name ?? initial?.name ?? "");
  const [prompt, setPrompt] = useState(meta?.prompt ?? initial?.prompt ?? "");
  const [agent, setAgent] = useState<AgentKind>(initialAgent);
  const [model, setModel] = useState(meta?.agent !== "pi" ? meta?.model ?? DEFAULT_MODEL[initialAgent] : DEFAULT_MODEL[initialAgent]);
  const [providerId, setProviderId] = useState(
    meta?.agent === "pi" ? meta?.providerId ?? (meta as { piChannelId?: string }).piChannelId ?? "" : "",
  );
  const [piModel, setPiModel] = useState(meta?.agent === "pi" ? meta?.model ?? "" : "");
  const [effort, setEffort] = useState<ReasoningEffort>(meta?.effort ?? initial?.effort ?? "medium");
  const [projectId, setProjectId] = useState(meta?.projectId ?? initial?.projectId ?? "");
  const [schedule, setSchedule] = useState<ScheduleSpec>(meta?.schedule ?? initial?.schedule ?? { kind: "daily", hour: 9, minute: 0 });
  // 完成后通知(opt-in):从「设置 → 通知」已配置的渠道里选要推送到哪几个;空 = 不通知。
  const [notifyChannels, setNotifyChannels] = useState<PushChannelKind[]>(
    meta?.notifyChannels ?? initial?.notifyChannels ?? [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isPi = agent === "pi";

  const changeAgent = (a: AgentKind) => {
    setAgent(a);
    if (a !== "pi") setModel(DEFAULT_MODEL[a]);
  };


  // 完成后通知:可选渠道 = 「设置 → 通知」里已配置(启用且填好 webhook)的外部渠道 + 已启用的内部通知。
  const availableChannels: { kind: PushChannelKind; label: string }[] = [
    ...enabledPushTargets(pushSettings).map((tg) => ({ kind: tg.target.kind as PushChannelKind, label: tg.label })),
    ...(pushSettings.internal?.enabled ? [{ kind: "internal" as PushChannelKind, label: "桌面通知（系统）" }] : []),
  ];
  const toggleChannel = (kind: PushChannelKind) =>
    setNotifyChannels((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]));

  const piReady = !isPi || (!!providerId && !!piModel);
  const canSubmit = !!name.trim() && !!prompt.trim() && piReady && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    const input: AutomationInput = {
      name: name.trim(),
      prompt: prompt.trim(),
      agent,
      model: isPi ? piModel : model || DEFAULT_MODEL[agent],
      providerId: isPi ? providerId : undefined,
      projectId: projectId || undefined,
      cwd: projectId ? projects.find((p) => p.id === projectId)?.path : undefined,
      effort,
      notifyChannels,
      schedule,
    };
    try {
      if (editing && meta) await update.mutateAsync({ id: meta.id, patch: input });
      else await create.mutateAsync(input);
      onClose();
    } catch (err) {
      onToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="pw-dlg-overlay" onClick={onClose}>
      <div
        className="pw-dlg pw-auto-dlg"
        role="dialog"
        aria-label={editing ? "编辑自动化" : "新建自动化"}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="pw-dlg-x" title="关闭" onClick={onClose}>
          <Icon.X size={15} />
        </button>
        <div className="pw-auto-dlg-body">
          <div className="pw-auto-dlg-h">{editing ? "编辑自动化" : "新建自动化"}</div>

          <label className="pw-set-field">
            <span className="pw-set-lbl">标题</span>
            <input
              className="pw-set-input"
              value={name}
              placeholder="例如：每日代码巡检"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className="pw-set-field">
            <span className="pw-set-lbl">内容（提示词）</span>
            <textarea
              className="pw-set-input pw-auto-ta"
              value={prompt}
              placeholder="到点要让 agent 执行的提示词…"
              rows={5}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>

          <div className="pw-auto-dlg-row">
            <Select
              label="默认 Agent"
              value={agent}
              options={availAgents.map((a) => ({ value: a, label: AGENT_LABEL[a] }))}
              onChange={(v) => changeAgent(v as AgentKind)}
            />
            {isPi ? (
              <ModelRefField
                // Catalog 驱动（计划 §4.2/§5）：候选是「认证可用 ∧ 未隐藏」的 Provider；
                // 引用悬空时进阻断态，定时任务在后台跑，静默换模型的后果用户根本看不见。
                label="模型"
                value={providerId && piModel ? { providerId, modelId: piModel } : undefined}
                onChange={(ref) => {
                  setProviderId(ref.providerId);
                  setPiModel(ref.modelId);
                }}
              />
            ) : (
              <Select
                label="模型"
                value={model}
                options={AGENT_MODELS[agent]}
                onChange={setModel}
              />
            )}
          </div>

          <div className="pw-auto-dlg-row">
            <Select
              label="项目"
              value={projectId}
              options={[
                { value: "", label: "无（在用户主目录运行）" },
                ...projects.map((p) => ({ value: p.id, label: p.name })),
              ]}
              onChange={setProjectId}
            />
            <div className="pw-set-field">
              <SegmentedRadio
                label="推理强度"
                value={effortToLabel(effort)}
                options={EFFORT_ORDER.map(effortToLabel)}
                onChange={(l) => setEffort(labelToEffort(l))}
              />
              <span className="pw-set-hint">部分模型支持；不支持的 Agent（如 Pi）会忽略</span>
            </div>
          </div>

          <ScheduleEditor value={schedule} onChange={setSchedule} />

          <div className="pw-set-field">
            <span className="pw-set-lbl">完成后通知</span>
            {availableChannels.length ? (
              <>
                <div className="pw-auto-notify-chs">
                  {availableChannels.map((ch) => (
                    <label key={ch.kind} className="pw-auto-notify-ch">
                      <input
                        type="checkbox"
                        checked={notifyChannels.includes(ch.kind)}
                        onChange={() => toggleChannel(ch.kind)}
                      />
                      <span>{ch.label}</span>
                    </label>
                  ))}
                </div>
                <span className="pw-set-hint">执行完成后把结果推送到选中的渠道;不选则不通知。</span>
              </>
            ) : (
              <span className="pw-set-hint">请先在「设置 → 通知」配置推送渠道,再回到这里选择。</span>
            )}
          </div>
        </div>
        <div className="pw-auto-dlg-foot">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!canSubmit} onClick={submit}>
            {saving ? "保存中…" : editing ? "保存" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
