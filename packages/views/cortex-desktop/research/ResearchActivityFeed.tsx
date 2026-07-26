// Deep Research 的实时活动流水：执行了哪条查询、抓到哪个域名、Gap Planner 做了什么决策。
//
// 它是「研究正在干什么」的唯一实时视图——阶段徽标只能告诉用户"在抓取"，流水才能告诉他
// "正在抓 example.com、上一轮判定要补充检索"。数据全部来自 ui-store 的事件派生态
// （main → research:event → applyEvent），本组件不发起任何请求。
//
// 隐私：事件侧已保证 text 只含查询词 / 域名 / 决策名（见 core 的 ResearchActivityEvent 注释），
// 这里直接渲染即可；**不要**在这里去 view.documents 里补标题或 URL，那是 evidence 级别的数据。
import { useEffect, useRef, type ReactElement } from "react";
import type { ResearchActivity } from "@cortex-work/core/research/ui-store";

/// 各类流水的中文标签（与编排层 emit 的 kind 一一对应）。
const ACTIVITY_LABELS: Record<ResearchActivity["kind"], string> = {
  query: "检索",
  document: "采信",
  fetch_failed: "未取到",
  decision: "决策",
  report: "撰写",
};

/// 展示的最大条数。store 侧已按会话截到 200 条，这里再收一道：
/// 一次性渲染几百个 DOM 节点对「最近发生了什么」这个诉求没有增益。
const MAX_VISIBLE = 60;

export interface ResearchActivityFeedProps {
  activities: readonly ResearchActivity[];
  /// 会话是否仍在跑。跑完之后不再自动滚动，让用户可以安静地回看。
  running: boolean;
}

/// 只取 HH:MM:SS。流水是"刚刚发生的事"，日期没有信息量。
/// 非法时间串（跨版本数据）原样吞掉，不能让一条脏数据把整个面板炸掉。
function clockOf(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toTimeString().slice(0, 8);
}

/// 实时活动流水面板。
export function ResearchActivityFeed({
  activities,
  running,
}: ResearchActivityFeedProps): ReactElement | null {
  const endRef = useRef<HTMLLIElement | null>(null);
  const visible = activities.slice(-MAX_VISIBLE);

  // 新条目到达时滚到底。**只在运行中跟随**：会话结束后用户往往正在往回翻，
  // 这时把他拽回底部是很烦人的。scrollIntoView 在 jsdom 里不存在，用可选调用兜底。
  useEffect(() => {
    if (!running) return;
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [running, activities.length]);

  if (visible.length === 0) return null;

  return (
    <section className="pw-res-sec">
      <div className="pw-res-sec-title">实时活动</div>
      <ul className="pw-res-feed">
        {visible.map((item, index) => (
          // key 用「时间 + 序号」：同一毫秒可能有多条（一轮里的多条查询），单用时间会撞。
          <li key={`${item.at}-${index}`} className={`pw-res-feed-item is-${item.kind}`}>
            <span className="pw-res-feed-time">{clockOf(item.at)}</span>
            <span className="pw-res-feed-kind">{ACTIVITY_LABELS[item.kind]}</span>
            <span className="pw-res-feed-text">{item.text}</span>
          </li>
        ))}
        {/* 滚动锚点。用 li 而不是 div：ul 的直接子元素只能是 li，
            混入 div 在部分浏览器里会让 list 语义与样式一起失效。 */}
        <li ref={endRef} className="pw-res-feed-end" aria-hidden="true" />
      </ul>
    </section>
  );
}
