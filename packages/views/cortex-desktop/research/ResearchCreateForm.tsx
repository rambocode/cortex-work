// 新建研究表单：目标 + 强度档位 + 数据出站策略 + 来源范围，提交后 create → run。
//
// 预算数字全部取自 core 的 MODE_BUDGETS，不在 UI 里重抄一份——抄一份的结果必然是
// core 调了预算而界面还在展示旧值，用户按旧承诺规划时间。
//
// 提交是两步（create 再 run）而不是一步：create 成功即表示会话已落库、可在列表里看到，
// 之后 run 失败也不会丢掉用户填的目标（能从列表里重跑）。所以 run 的失败只做提示，
// 不回滚已创建的会话。
import { useState, type ReactElement } from "react";
import { MODE_BUDGETS } from "@cortex-work/core/research/budget";
import type {
  ModelDataPolicy,
  ResearchConsumer,
  ResearchMode,
  ResearchRequest,
  ResearchSessionSummary,
  SourceScope,
} from "@cortex-work/core/research/types";
import type { ResearchBridgeLike } from "./bridge-like";
import { MODEL_DATA_POLICY_LABELS, RESEARCH_MODE_LABELS } from "./labels";
import { ResearchPolicyNotice } from "./ResearchPolicyNotice";

/// 新建研究表单的 props。
export interface ResearchCreateFormProps {
  bridge: ResearchBridgeLike;
  /// 发起方（决定 main 侧的默认配置，见 core 的 consumer.ts）。整窗 Deep Research 固定 deep_research。
  consumer?: ResearchConsumer;
  /// 收件方展示名，透传给策略告知条。
  providerLabel?: string;
  /// 数据出站策略的默认值，来自设置页的「默认数据出站策略」。
  ///
  /// 由宿主注入而不是表单自己读 store：views 层不依赖 personal store（那是个人工作区的
  /// 设置容器），保持组件可在任意宿主里复用。缺省退回 metadata_only。
  defaultModelDataPolicy?: ModelDataPolicy;
  /// 创建完成。startError 非空表示「会话建好了但没跑起来」——宿主必须把它显示在会话视图上，
  /// 因为本表单在这一刻就被卸载，局部 state 里的错误会随之丢失。
  onCreated: (summary: ResearchSessionSummary, startError?: string) => void;
  onCancel: () => void;
}

/// 可勾选的来源范围。enterprise 需要 tenantId，桌面个人版没有该概念，暂不提供。
///
/// **local_file 在 M1 是禁用的，这条与 IPC schema 是硬对齐关系**：
/// main 的 ipc/research.ts 里 sourceScopeSchema 只认 public_web / memory，且整个请求是 .strict()，
/// 因为 local_file 带 roots（本地路径）＝ 让 renderer 指挥主进程去读哪些目录，属 spec §16 禁止项。
/// 放开它必须等 U9 的目录授权流程（main 侧弹目录选择器、把授权结果存进设置、由 main 自行注入），
/// 在那之前允许勾选只会让用户点完「开始研究」收到一条 zod 报错。
const SCOPE_OPTIONS = [
  { key: "public_web", label: "公开网页", disabled: false },
  { key: "local_file", label: "本地文件", disabled: true },
  { key: "memory", label: "个人记忆", disabled: false },
] as const;

type ScopeKey = (typeof SCOPE_OPTIONS)[number]["key"];

/// 勾选项 → SourceScope。local_file 的 roots 先给空数组：
/// 「来源可用但尚未选定目录」是 core 定义的合法中间态（见 types.ts SourceScope），
/// 具体目录白名单由后续接线阶段接系统目录选择器补上。
function toScope(key: ScopeKey): SourceScope {
  if (key === "local_file") return { kind: "local_file", roots: [] };
  if (key === "memory") return { kind: "memory" };
  return { kind: "public_web" };
}

/// 把模式预算压成一行人话摘要（时长按分钟取整，毫秒对用户无意义）。
function budgetSummary(mode: ResearchMode): string {
  const b = MODE_BUDGETS[mode];
  return `最多 ${b.maxRounds} 轮 · ${b.maxDocuments} 篇文档 · ${Math.round(b.maxDurationMs / 60000)} 分钟`;
}

/// 新建研究表单：目标、模式、来源范围、模型数据策略的采集入口，提交后交给宿主发起 create。
export function ResearchCreateForm({
  bridge,
  consumer = "deep_research",
  providerLabel,
  defaultModelDataPolicy,
  onCreated,
  onCancel,
}: ResearchCreateFormProps): ReactElement {
  const [objective, setObjective] = useState("");
  const [mode, setMode] = useState<ResearchMode>("standard");
  // 默认值来自**设置页**的「默认数据出站策略」，缺省才退回 metadata_only。
  //
  // 这里曾经把 metadata_only 写死，无视设置——后果比看上去严重得多：metadata_only 下模型
  // 从来看不到正文，只拿到标题与域名，报告于是变成「根据标题字面含义推测」。
  // 用户看到的是「报告和研究对象没关系」，却完全不知道自己设的那档策略压根没生效。
  const [policy, setPolicy] = useState<ModelDataPolicy>(defaultModelDataPolicy ?? "metadata_only");
  const [scopes, setScopes] = useState<ScopeKey[]>(["public_web"]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = objective.trim().length > 0 && scopes.length > 0 && !submitting;

  // 禁用项永远进不了 scopes：只靠 input 的 disabled 是不够的——那是 DOM 层的约定，
  // 而「请求里不得出现带本地路径的来源」是 IPC 契约，必须在状态这一层就成立。
  const toggleScope = (key: ScopeKey) => {
    if (SCOPE_OPTIONS.find((o) => o.key === key)?.disabled) return;
    setScopes((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const request: ResearchRequest = {
      consumer,
      objective: objective.trim(),
      mode,
      // 按 SCOPE_OPTIONS 的固定顺序输出，避免勾选先后影响请求内容（便于去重与测试）。
      // 再过一次 !o.disabled 是**兜底**：即便状态被别的路径污染，未开放的来源也出不了这个函数。
      sourceScopes: SCOPE_OPTIONS.filter((o) => !o.disabled && scopes.includes(o.key)).map((o) =>
        toScope(o.key),
      ),
      modelDataPolicy: policy,
      output: { format: "report", requireCitations: true },
    };
    let summary: ResearchSessionSummary;
    try {
      summary = await bridge.create(request);
    } catch (e) {
      setError(`创建失败：${e instanceof Error ? e.message : String(e)}`);
      setSubmitting(false);
      return;
    }
    let startError: string | undefined;
    try {
      await bridge.run(summary.sessionId);
    } catch (e) {
      // 会话已创建，只是没跑起来（最常见：搜索服务未配置）。**必须把原因交给宿主**——
      // 只 setError 是没用的，下一行的 onCreated 会立刻卸载本表单，那条提示还没来得及被看见
      // 就消失了，用户只剩一个停在「待开始」的会话和零线索。会话本身仍可在视图里点「开始」重跑。
      startError = `启动失败：${e instanceof Error ? e.message : String(e)}`;
      setError(startError);
    }
    setSubmitting(false);
    onCreated(summary, startError);
  };

  return (
    <div className="pw-res-form">
      <div className="pw-res-form-title">新建研究</div>

      <label className="pw-res-field">
        <span className="pw-res-lbl">研究目标</span>
        <textarea
          className="pw-res-textarea"
          rows={4}
          value={objective}
          placeholder="想弄清楚什么？描述得越具体，拆解出的子问题越准"
          onChange={(e) => setObjective(e.target.value)}
        />
      </label>

      <fieldset className="pw-res-fieldset">
        <legend className="pw-res-lbl">研究强度</legend>
        {(["quick", "standard", "deep"] as const).map((m) => (
          <label key={m} className={`pw-res-opt${mode === m ? " is-on" : ""}`}>
            <input
              type="radio"
              name="research-mode"
              checked={mode === m}
              onChange={() => setMode(m)}
            />
            <span className="pw-res-opt-l">{RESEARCH_MODE_LABELS[m].label}</span>
            <span className="pw-res-opt-hint">{RESEARCH_MODE_LABELS[m].hint}</span>
            <span className="pw-res-opt-budget">{budgetSummary(m)}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="pw-res-fieldset">
        <legend className="pw-res-lbl">数据出站策略</legend>
        {(["local_only", "metadata_only", "evidence_allowed"] as const).map((p) => (
          <label key={p} className={`pw-res-opt${policy === p ? " is-on" : ""}`}>
            <input
              type="radio"
              name="research-policy"
              checked={policy === p}
              onChange={() => setPolicy(p)}
            />
            <span className="pw-res-opt-l">{MODEL_DATA_POLICY_LABELS[p].label}</span>
            <span className="pw-res-opt-hint">{MODEL_DATA_POLICY_LABELS[p].hint}</span>
          </label>
        ))}
      </fieldset>

      {/* 纯告知模式（不传 onAcknowledge）：随选择实时变化，用户按下「开始研究」前一定看得到。 */}
      <ResearchPolicyNotice policy={policy} providerLabel={providerLabel} />

      <fieldset className="pw-res-fieldset">
        <legend className="pw-res-lbl">来源范围</legend>
        {SCOPE_OPTIONS.map((o) => (
          <label key={o.key} className={`pw-res-check${o.disabled ? " is-disabled" : ""}`}>
            <input
              type="checkbox"
              checked={scopes.includes(o.key)}
              disabled={o.disabled}
              onChange={() => toggleScope(o.key)}
            />
            <span>{o.label}</span>
            {/* 说明为什么不能选，否则用户只会看到一个没反应的勾选框。 */}
            {o.disabled ? <span className="pw-res-soon">即将支持</span> : null}
          </label>
        ))}
      </fieldset>

      {error ? <div className="pw-res-error">{error}</div> : null}

      <div className="pw-res-form-actions">
        <button type="button" className="pw-res-btn" onClick={onCancel}>
          取消新建
        </button>
        <button
          type="button"
          className="pw-res-btn is-primary"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          开始研究
        </button>
      </div>
    </div>
  );
}
