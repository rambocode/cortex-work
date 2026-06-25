// FlowNodeForm.tsx — 流程控制节点配置表单。
// 覆盖：condition / switch / filter / merge / loop / subworkflow / delay
// condition/filter/switch 的 leftExpr/operator/rightValue/caseSensitive；
// loop mode/arraySource/concurrency/maxIterations/condition 字段；
// subworkflow workflowId 选择器；delay delayMs。

import type { WorkflowNode } from "@cortex-work/core";
import type {
  WorkflowConditionConfig,
  WorkflowSwitchConfig,
  WorkflowFilterConfig,
  WorkflowMergeConfig,
  WorkflowLoopConfig,
  WorkflowSubWorkflowConfig,
  WorkflowDelayConfig,
  WorkflowSwitchRule,
  WorkflowConditionOperator,
  WorkflowLoopMode,
  WorkflowLoopExecution,
  WorkflowMergeMode,
  WorkflowDef,
} from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { INPUT_CLS, FIELD_LABEL_CLS, SECTION_LABEL_CLS } from "./TriggerNodeForm";

// ── 常量 ─────────────────────────────────────────────────────────────────────

const CONDITION_OPERATORS: Array<{ value: WorkflowConditionOperator; label: string }> = [
  { value: "equals", label: "等于" },
  { value: "notEquals", label: "不等于" },
  { value: "contains", label: "包含" },
  { value: "notContains", label: "不包含" },
  { value: "startsWith", label: "开头是" },
  { value: "endsWith", label: "结尾是" },
  { value: "isEmpty", label: "为空" },
  { value: "isNotEmpty", label: "非空" },
  { value: "gt", label: "大于" },
  { value: "gte", label: "大于等于" },
  { value: "lt", label: "小于" },
  { value: "lte", label: "小于等于" },
];

/** 不需要 rightValue 的运算符（isEmpty/isNotEmpty）*/
const NO_VALUE_OPS = new Set<WorkflowConditionOperator>(["isEmpty", "isNotEmpty"]);

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  node: WorkflowNode & {
    type:
      | "condition"
      | "switch"
      | "filter"
      | "merge"
      | "loop"
      | "subworkflow"
      | "delay";
  };
  onChange: (updated: WorkflowNode) => void;
  /** 工作流列表，供 subworkflow/loop workflowId 选择器使用。 */
  workflows?: WorkflowDef[];
};

// ── 共享：条件表达式行 ────────────────────────────────────────────────────────

function ConditionRow({
  leftExpr,
  operator,
  rightValue,
  caseSensitive,
  onLeftExpr,
  onOperator,
  onRightValue,
  onCaseSensitive,
}: {
  leftExpr: string;
  operator: WorkflowConditionOperator;
  rightValue: string;
  caseSensitive: boolean;
  onLeftExpr: (v: string) => void;
  onOperator: (v: WorkflowConditionOperator) => void;
  onRightValue: (v: string) => void;
  onCaseSensitive: (v: boolean) => void;
}) {
  const noVal = NO_VALUE_OPS.has(operator);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          className={`${INPUT_CLS} flex-1 font-mono`}
          value={leftExpr}
          placeholder="{{$input.text}}"
          onChange={(e) => onLeftExpr(e.target.value)}
        />
        <select
          className={`${INPUT_CLS} w-[120px] shrink-0`}
          value={operator}
          onChange={(e) => onOperator(e.target.value as WorkflowConditionOperator)}
        >
          {CONDITION_OPERATORS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {!noVal ? (
        <input
          className={INPUT_CLS}
          value={rightValue}
          placeholder="比较值"
          onChange={(e) => onRightValue(e.target.value)}
        />
      ) : null}
      <label className="flex items-center gap-1.5 text-[12px] text-ds-muted">
        <input
          type="checkbox"
          checked={caseSensitive}
          onChange={(e) => onCaseSensitive(e.target.checked)}
        />
        区分大小写
      </label>
    </div>
  );
}

// ── condition ─────────────────────────────────────────────────────────────────

function ConditionForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "condition" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowConditionConfig;

  function updateConfig(patch: Partial<WorkflowConditionConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11.5px] text-ds-faint">
        条件成立走 <span className="font-mono text-emerald-500">true</span> 输出，否则走{" "}
        <span className="font-mono text-red-400">false</span> 输出。
      </p>
      <ConditionRow
        leftExpr={cfg.leftExpr}
        operator={cfg.operator}
        rightValue={cfg.rightValue}
        caseSensitive={cfg.caseSensitive}
        onLeftExpr={(v) => updateConfig({ leftExpr: v })}
        onOperator={(v) => updateConfig({ operator: v })}
        onRightValue={(v) => updateConfig({ rightValue: v })}
        onCaseSensitive={(v) => updateConfig({ caseSensitive: v })}
      />
    </div>
  );
}

// ── filter ────────────────────────────────────────────────────────────────────

function FilterForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "filter" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowFilterConfig;

  function updateConfig(patch: Partial<WorkflowFilterConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11.5px] text-ds-faint">
        条件不满足时数据被丢弃，不触发后续节点。
      </p>
      <ConditionRow
        leftExpr={cfg.leftExpr}
        operator={cfg.operator}
        rightValue={cfg.rightValue}
        caseSensitive={cfg.caseSensitive}
        onLeftExpr={(v) => updateConfig({ leftExpr: v })}
        onOperator={(v) => updateConfig({ operator: v })}
        onRightValue={(v) => updateConfig({ rightValue: v })}
        onCaseSensitive={(v) => updateConfig({ caseSensitive: v })}
      />
    </div>
  );
}

// ── switch ────────────────────────────────────────────────────────────────────

function SwitchForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "switch" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowSwitchConfig;

  function updateConfig(patch: Partial<WorkflowSwitchConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  function updateRule(idx: number, patch: Partial<WorkflowSwitchRule>) {
    const rules = cfg.rules.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    updateConfig({ rules });
  }

  function addRule() {
    updateConfig({
      rules: [
        ...cfg.rules,
        { leftExpr: "", operator: "equals", rightValue: "", caseSensitive: false },
      ],
    });
  }

  function removeRule(idx: number) {
    updateConfig({ rules: cfg.rules.filter((_, i) => i !== idx) });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[11.5px] text-ds-faint">
        按顺序匹配，第一条命中的规则决定输出分支（case-0, case-1…）。
      </p>

      {/* 规则列表 */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className={SECTION_LABEL_CLS}>规则列表</span>
          <button
            type="button"
            onClick={addRule}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent hover:bg-accent/10 transition"
          >
            <Icon.Plus size={13} sw={2} />
            添加规则
          </button>
        </div>
        {cfg.rules.length === 0 ? (
          <p className="py-2 text-center text-[12px] text-ds-faint">暂无规则</p>
        ) : (
          cfg.rules.map((rule, idx) => (
            <div
              key={idx}
              className="rounded-xl border border-ds-border bg-ds-card/60 p-3 flex flex-col gap-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-mono text-ds-faint">
                  case-{idx}
                </span>
                <button
                  type="button"
                  onClick={() => removeRule(idx)}
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-ds-faint hover:bg-red-500/10 hover:text-red-600 transition"
                >
                  <Icon.X size={12} sw={2} />
                </button>
              </div>
              <ConditionRow
                leftExpr={rule.leftExpr}
                operator={rule.operator}
                rightValue={rule.rightValue}
                caseSensitive={rule.caseSensitive}
                onLeftExpr={(v) => updateRule(idx, { leftExpr: v })}
                onOperator={(v) => updateRule(idx, { operator: v })}
                onRightValue={(v) => updateRule(idx, { rightValue: v })}
                onCaseSensitive={(v) => updateRule(idx, { caseSensitive: v })}
              />
            </div>
          ))
        )}
      </div>

      {/* fallback 开关 */}
      <label className="flex items-center gap-2 text-[13px] text-ds-muted">
        <input
          type="checkbox"
          checked={cfg.fallback}
          onChange={(e) => updateConfig({ fallback: e.target.checked })}
        />
        开启 fallback 输出（所有规则未命中时走 fallback）
      </label>
    </div>
  );
}

// ── merge ─────────────────────────────────────────────────────────────────────

function MergeForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "merge" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowMergeConfig;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>合并模式</label>
        <select
          className={INPUT_CLS}
          value={cfg.mode}
          onChange={(e) =>
            onChange({ ...node, config: { ...cfg, mode: e.target.value as WorkflowMergeMode } })
          }
        >
          <option value="array">Array（合并为数组）</option>
          <option value="object">Object（合并为对象）</option>
        </select>
      </div>
    </div>
  );
}

// ── loop ──────────────────────────────────────────────────────────────────────

function LoopForm({
  node,
  onChange,
  workflows,
}: {
  node: WorkflowNode & { type: "loop" };
  onChange: (updated: WorkflowNode) => void;
  workflows?: WorkflowDef[];
}) {
  const cfg = node.config as WorkflowLoopConfig;

  function updateConfig(patch: Partial<WorkflowLoopConfig>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  const isForeach = cfg.mode === "foreach";

  return (
    <div className="flex flex-col gap-4">
      {/* 循环体工作流 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>循环体工作流</label>
        <select
          className={INPUT_CLS}
          value={cfg.workflowId}
          onChange={(e) => updateConfig({ workflowId: e.target.value })}
        >
          <option value="">选择工作流…</option>
          {(workflows ?? []).map((wf) => (
            <option key={wf.id} value={wf.id}>
              {wf.name || wf.id}
            </option>
          ))}
        </select>
      </div>

      {/* 循环模式 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>循环模式</label>
        <select
          className={INPUT_CLS}
          value={cfg.mode ?? "condition"}
          onChange={(e) => updateConfig({ mode: e.target.value as WorkflowLoopMode })}
        >
          <option value="condition">条件循环（While）</option>
          <option value="foreach">遍历数组（ForEach）</option>
        </select>
      </div>

      {/* condition 模式：停止条件 */}
      {!isForeach ? (
        <div className="flex flex-col gap-2">
          <span className={SECTION_LABEL_CLS}>停止条件（满足时结束循环）</span>
          <ConditionRow
            leftExpr={cfg.leftExpr}
            operator={cfg.operator}
            rightValue={cfg.rightValue}
            caseSensitive={cfg.caseSensitive}
            onLeftExpr={(v) => updateConfig({ leftExpr: v })}
            onOperator={(v) => updateConfig({ operator: v })}
            onRightValue={(v) => updateConfig({ rightValue: v })}
            onCaseSensitive={(v) => updateConfig({ caseSensitive: v })}
          />
        </div>
      ) : null}

      {/* foreach 模式：数组来源 / 并发设置 */}
      {isForeach ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className={FIELD_LABEL_CLS}>数组来源表达式</label>
            <input
              className={`${INPUT_CLS} font-mono`}
              value={cfg.arraySource ?? ""}
              placeholder="{{$input.items}}（留空 = payload.json）"
              onChange={(e) => updateConfig({ arraySource: e.target.value || undefined })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className={FIELD_LABEL_CLS}>执行方式</label>
            <select
              className={INPUT_CLS}
              value={cfg.execution ?? "sequential"}
              onChange={(e) =>
                updateConfig({ execution: e.target.value as WorkflowLoopExecution })
              }
            >
              <option value="sequential">顺序</option>
              <option value="parallel">并行</option>
            </select>
          </div>
          {cfg.execution === "parallel" ? (
            <div className="flex flex-col gap-1">
              <label className={FIELD_LABEL_CLS}>最大并发数（1–8）</label>
              <input
                type="number"
                className={INPUT_CLS}
                value={cfg.concurrency ?? 4}
                min={1}
                max={8}
                onChange={(e) =>
                  updateConfig({ concurrency: Number(e.target.value) })
                }
              />
            </div>
          ) : null}
          <label className="flex items-center gap-2 text-[12px] text-ds-muted">
            <input
              type="checkbox"
              checked={cfg.continueOnError ?? false}
              onChange={(e) => updateConfig({ continueOnError: e.target.checked })}
            />
            失败项包装为 {"{error}"} 而非中断循环
          </label>
        </div>
      ) : null}

      {/* 最大迭代次数 */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>最大迭代次数（1–100）</label>
        <input
          type="number"
          className={INPUT_CLS}
          value={cfg.maxIterations}
          min={1}
          max={100}
          onChange={(e) => updateConfig({ maxIterations: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}

// ── subworkflow ───────────────────────────────────────────────────────────────

function SubWorkflowForm({
  node,
  onChange,
  workflows,
}: {
  node: WorkflowNode & { type: "subworkflow" };
  onChange: (updated: WorkflowNode) => void;
  workflows?: WorkflowDef[];
}) {
  const cfg = node.config as WorkflowSubWorkflowConfig;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>子工作流</label>
        <select
          className={INPUT_CLS}
          value={cfg.workflowId}
          onChange={(e) =>
            onChange({ ...node, config: { ...cfg, workflowId: e.target.value } })
          }
        >
          <option value="">选择工作流…</option>
          {(workflows ?? []).map((wf) => (
            <option key={wf.id} value={wf.id}>
              {wf.name || wf.id}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ── delay ─────────────────────────────────────────────────────────────────────

function DelayForm({
  node,
  onChange,
}: {
  node: WorkflowNode & { type: "delay" };
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config as WorkflowDelayConfig;

  // 内部以秒显示（上限 86400s），实际存储 ms
  const secs = cfg.delayMs / 1000;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>延迟时长（毫秒）</label>
        <input
          type="number"
          className={INPUT_CLS}
          value={cfg.delayMs}
          min={0}
          max={86400000}
          step={100}
          onChange={(e) =>
            onChange({ ...node, config: { ...cfg, delayMs: Number(e.target.value) } })
          }
        />
        <span className="text-[11px] text-ds-faint">{secs.toFixed(1)} 秒</span>
      </div>
    </div>
  );
}

// ── 主导出 ───────────────────────────────────────────────────────────────────

export function FlowNodeForm({ node, onChange, workflows }: Props) {
  if (node.type === "condition") {
    return (
      <ConditionForm
        node={node as WorkflowNode & { type: "condition" }}
        onChange={onChange}
      />
    );
  }
  if (node.type === "switch") {
    return (
      <SwitchForm
        node={node as WorkflowNode & { type: "switch" }}
        onChange={onChange}
      />
    );
  }
  if (node.type === "filter") {
    return (
      <FilterForm
        node={node as WorkflowNode & { type: "filter" }}
        onChange={onChange}
      />
    );
  }
  if (node.type === "merge") {
    return (
      <MergeForm
        node={node as WorkflowNode & { type: "merge" }}
        onChange={onChange}
      />
    );
  }
  if (node.type === "loop") {
    return (
      <LoopForm
        node={node as WorkflowNode & { type: "loop" }}
        onChange={onChange}
        workflows={workflows}
      />
    );
  }
  if (node.type === "subworkflow") {
    return (
      <SubWorkflowForm
        node={node as WorkflowNode & { type: "subworkflow" }}
        onChange={onChange}
        workflows={workflows}
      />
    );
  }
  if (node.type === "delay") {
    return (
      <DelayForm
        node={node as WorkflowNode & { type: "delay" }}
        onChange={onChange}
      />
    );
  }
  return null;
}
