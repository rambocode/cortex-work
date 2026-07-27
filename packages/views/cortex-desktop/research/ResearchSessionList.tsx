// Deep Research 左栏：会话列表 + 新建 / 删除入口。
//
// **隐私红线（spec §19.3.2）**：本组件的入参只有 ResearchSessionSummary——只有计数与状态，
// 没有正文。渲染路径**绝不**读取 chunk.text / document.contentRef 之类的字段，
// 哪怕调用方误传了一个带正文的超集对象也不能碰（ResearchSessionList.test.tsx 用会抛错的
// getter 埋雷来钉死这一点）。要看证据请走右栏的按需加载。
import type { ReactElement } from "react";
import type { ResearchSessionSummary } from "@cortex-work/core/research/types";
import { RESEARCH_MODE_LABELS, RESEARCH_STATUS_META } from "./labels";

/// 会话列表的 props。**只接收 summary**：正文字段绝不该出现在这一层（隐私红线）。
export interface ResearchSessionListProps {
  sessions: ResearchSessionSummary[];
  activeSessionId: string | null;
  loading?: boolean;
  onSelect: (sessionId: string) => void;
  /// 新建入口。会话右栏面板不给这个入口（发起研究走输入框的 /skill:research），
  /// 故与 hideCreate 一起是可选的。
  onCreate?: () => void;
  hideCreate?: boolean;
  /// 删除入口。缺省则不渲染删除按钮——嵌在会话右栏里时，删掉研究会让会话流里的
  /// 研究卡片变成死链，那个决定应当在能看到卡片的地方做。
  onDelete?: (sessionId: string) => void;
}

/// ISO 时间 → 「MM-DD HH:mm」。列表只需要相对定位，完整时间戳留给详情页。
/// 非法值原样返回，避免脏数据把整列表打崩。
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/// 研究会话列表。渲染路径**只读元数据**（标题、状态、计数、时间），不读 text / contentRef——
/// 对应测试往 summary 上挂了会抛错的 getter，一旦有人在这里读正文就会当场炸。
export function ResearchSessionList({
  sessions,
  activeSessionId,
  loading,
  onSelect,
  onCreate,
  hideCreate,
  onDelete,
}: ResearchSessionListProps): ReactElement {
  const showCreate = !hideCreate && !!onCreate;
  return (
    <div className="pw-res-list">
      {showCreate ? (
        <div className="pw-res-list-top">
          <button type="button" className="pw-res-btn is-primary" onClick={onCreate}>
            新建研究
          </button>
        </div>
      ) : null}

      {loading ? <div className="pw-res-hint">加载中…</div> : null}

      {sessions.length === 0 && !loading ? (
        <div className="pw-res-empty">
          {showCreate ? "尚无研究记录，点上方「新建研究」开始" : "尚无研究记录"}
        </div>
      ) : null}

      <div className="pw-res-items">
        {sessions.map((s) => {
          const meta = RESEARCH_STATUS_META[s.status] ?? { label: s.status, tone: "idle" as const };
          const active = s.sessionId === activeSessionId;
          return (
            <div
              key={s.sessionId}
              className={`pw-res-item${active ? " is-active" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(s.sessionId)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelect(s.sessionId);
              }}
            >
              <div className="pw-res-item-head">
                <span className={`pw-res-badge is-${meta.tone}`}>{meta.label}</span>
                <span className="pw-res-item-mode">{RESEARCH_MODE_LABELS[s.mode]?.label ?? s.mode}</span>
                {onDelete ? (
                  <button
                    type="button"
                    className="pw-res-item-del"
                    aria-label="删除研究"
                    // 删除按钮嵌在可点击的行里，必须阻断冒泡，否则「删一个」会顺带把它选中。
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(s.sessionId);
                    }}
                  >
                    删除
                  </button>
                ) : null}
              </div>
              <div className="pw-res-item-obj">{s.objective}</div>
              <div className="pw-res-item-meta">
                {`${s.roundCount} 轮 · ${s.documentCount} 篇已抓取 · ${s.chunkCount} 片段 · ${shortTime(s.updatedAt)}`}
              </div>
              {s.status === "failed" && s.errorMessage ? (
                <div className="pw-res-item-err">{s.errorMessage}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
