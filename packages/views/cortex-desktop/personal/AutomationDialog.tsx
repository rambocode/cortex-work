// 创建/编辑自动化弹窗。复用 SettingsDialog 外壳风格（pw-dlg-overlay/pw-dlg/
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
import type {
  AgentKind,
  AutomationInput,
  AutomationMeta,
  ReasoningEffort,
  ScheduleSpec,
} from "@cortex-work/core";
import { ScheduleEditor } from "./ScheduleEditor";

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
  onClose,
  onToast,
}: {
  meta?: AutomationMeta; // 传入 = 编辑;否则新建
  onClose: () => void;
  onToast: (text: string) => void;
}) {
  const editing = !!meta;
  const projects = usePersonalStore((s) => s.projects);
  const piSettings = usePersonalStore((s) => s.piSettings);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const create = useCreateAutomation();
  const update = useUpdateAutomation();
  const saving = create.isPending || update.isPending;

  const availAgents = (Object.keys(AGENT_MODELS) as AgentKind[]).filter(
    (a) => a === "pi" || agentsAvailable?.[a],
  );
  const initialAgent: AgentKind = meta?.agent ?? availAgents[0] ?? "pi";

  const [name, setName] = useState(meta?.name ?? "");
  const [prompt, setPrompt] = useState(meta?.prompt ?? "");
  const [agent, setAgent] = useState<AgentKind>(initialAgent);
  const [model, setModel] = useState(meta?.agent !== "pi" ? meta?.model ?? DEFAULT_MODEL[initialAgent] : DEFAULT_MODEL[initialAgent]);
  const [piChannelId, setPiChannelId] = useState(meta?.agent === "pi" ? meta?.piChannelId ?? "" : "");
  const [piModel, setPiModel] = useState(meta?.agent === "pi" ? meta?.model ?? "" : "");
  const [effort, setEffort] = useState<ReasoningEffort>(meta?.effort ?? "medium");
  const [projectId, setProjectId] = useState(meta?.projectId ?? "");
  const [schedule, setSchedule] = useState<ScheduleSpec>(meta?.schedule ?? { kind: "daily", hour: 9, minute: 0 });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isPi = agent === "pi";
  const piModelOptions = piSettings.channels
    .filter((c) => c.enabled)
    .flatMap((c) => c.models.map((m) => ({ value: `${c.id}::${m.id}`, label: `${c.label} · ${m.label ?? m.id}` })));
  const piModelValue = `${piChannelId}::${piModel}`;

  const changeAgent = (a: AgentKind) => {
    setAgent(a);
    if (a !== "pi") setModel(DEFAULT_MODEL[a]);
  };

  const changePiModel = (encoded: string) => {
    const [cid, ...rest] = encoded.split("::");
    setPiChannelId(cid ?? "");
    setPiModel(rest.join("::"));
  };

  const piReady = !isPi || (!!piChannelId && !!piModel);
  const canSubmit = !!name.trim() && !!prompt.trim() && piReady && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    const input: AutomationInput = {
      name: name.trim(),
      prompt: prompt.trim(),
      agent,
      model: isPi ? piModel : model || DEFAULT_MODEL[agent],
      piChannelId: isPi ? piChannelId : undefined,
      projectId: projectId || undefined,
      cwd: projectId ? projects.find((p) => p.id === projectId)?.path : undefined,
      effort,
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
              <Select
                label="模型"
                value={piModelValue}
                options={piModelOptions.length ? piModelOptions : [{ value: "::", label: "无可用通道" }]}
                onChange={changePiModel}
                disabled={!piModelOptions.length}
                hint={piModelOptions.length ? undefined : "请先在设置中配置 Pi 的 LLM 通道"}
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
