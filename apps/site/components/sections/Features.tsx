import { featureIcon } from "@/components/icons";
import { Reveal } from "@/components/ui";
import type { Dict } from "@/lib/dictionary";
import type { Locale } from "@/lib/i18n";

/* =========================================================================
   Features · 核心能力（id="features"）
   server 组件：标题区 + 6 项轻卡（grid grid-3，移动折叠）。
   每项是一组并列单元、hover 升起，故用轻卡 card card--pad card--hover。
   图标放进小号荧光底圆，克制点缀、统一蓝紫氛围。
   scoped 样式（.feat-*）按契约集中在 globals.css 末尾（server 组件不可用内联 <style>）。
   ========================================================================= */

export default function Features({ d }: { d: Dict; locale: Locale }) {
  const { eyebrow, title, sub, items } = d.features;

  return (
    <section id="features" className="section">
      <div className="container">
        {/* —— 标题区 —— */}
        <Reveal className="content">
          <header className="feat-head">
            <span className="eyebrow">{eyebrow}</span>
            <h2 className="h2">{title}</h2>
            <p className="lead">{sub}</p>
          </header>
        </Reveal>

        {/* —— 6 项能力：grid grid-3（≤900 折两列、≤600 折单列，由 globals.css 处理）—— */}
        <div className="grid grid-3 feat-grid">
          {items.map((item, i) => {
            const Icon = featureIcon[item.icon];
            return (
              // 每张轻卡错峰入场；i 递增控制 stagger 延迟。
              <Reveal key={item.icon} className="content" i={i}>
                <article className="card card--pad card--hover feat-card">
                  {/* 荧光底圆：图标线条走荧光蓝，统一「智能氛围」 */}
                  <span className="feat-medallion" aria-hidden="true">
                    <Icon />
                  </span>
                  <h3 className="h3 feat-title">{item.title}</h3>
                  <p className="muted feat-desc">{item.desc}</p>
                </article>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
