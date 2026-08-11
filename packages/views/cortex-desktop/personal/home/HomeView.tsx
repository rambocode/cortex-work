// 个人工作区首页看板：落地页 Hero + 场景 tab / 快捷能力 chips。
// 原先的「用量日历 + 全局一日总结」已下线（信息价值低、抢输入框位置），改为一排直达入口，
// 见 ./SceneChips。
// HomeBoard 供 NewSessionLanding 复用,HomeView 为兼容现有 import 的薄包装。

import { LandingHero } from "./LandingHero";
import { SceneChips } from "./SceneChips";

// ── 首页看板（供 NewSessionLanding 复用） ─────────────────────────────────

export function HomeBoard() {
  return (
    <div className="pw-home">
      {/* 场景 tab 注入 Hero 文案下方(logo 右侧),chips 行留在 Hero 之下并随之上移 */}
      <SceneChips renderHero={(tabs) => <LandingHero tabs={tabs} />} />
    </div>
  );
}

// ── 首页容器（兼容 PersonalWorkspace 现有 import） ─────────────────────────

export function HomeView() {
  return (
    <main className="chat">
      <HomeBoard />
    </main>
  );
}
