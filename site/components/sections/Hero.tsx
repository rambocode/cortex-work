/* =========================================================================
   Hero · 首屏主视觉（server 组件，动效全部交给 CSS）
   结构：氛围层（aurora + neuron-field，z-index:0）→ .content 两列：
   左文案（eyebrow / display 标题 + glow-text 点睛 / lead / 两个 CTA /
   trust 小字 + note pill），右主视觉（发光水母 Jellyfish + halo 光晕）。
   - 桌面左文右图，移动端单列、文在上、水母在下并弱化。
   - 文案用 <Reveal> 包裹、靠 i 递增做错峰入场。
   - 自定义布局/动效写在文件内 scoped <style>，并在 reduced-motion 下静默。
   - 一切可见文案来自 d（Dict），不硬编码中英文。
   ========================================================================= */

import { IconArrowRight, IconDownload } from "@/components/icons";
import Jellyfish from "@/components/Jellyfish";
import HeroDemo from "@/components/HeroDemo";
import { Reveal } from "@/components/ui";
import type { Dict } from "@/lib/dictionary";
import type { Locale } from "@/lib/i18n";

export default function Hero({ d, locale }: { d: Dict; locale: Locale }) {
  return (
    <section className="section hero">
      {/* —— 底层氛围：极光 + 神经元星点，绝对定位铺底（z-index:0）—— */}
      <div className="aurora" aria-hidden="true" />
      <div className="neuron-field hero__field" aria-hidden="true" />

      {/* —— 内容层：两列网格（.content 自带 z-index:1）—— */}
      <div className="container content hero__grid">
        {/* 左列：文案与 CTA */}
        <div className="hero__copy">
          <Reveal i={0}>
            <span className="eyebrow">{d.hero.eyebrow}</span>
          </Reveal>

          <Reveal i={1}>
            {/* 标题两行：主句 + 荧光点睛词（点睛词块级独占一行，
                中英文均自然换行 + balance，避免强制 <br/> 在英文下产生参差） */}
            <h1 className="display hero__title" style={{ textWrap: "balance" }}>
              {d.hero.title}
              <span className="glow-text hero__accent">{d.hero.titleAccent}</span>
            </h1>
          </Reveal>

          <Reveal i={2}>
            <p className="lead hero__lead" style={{ textWrap: "balance" }}>
              {d.hero.sub}
            </p>
          </Reveal>

          <Reveal i={3}>
            <div className="hero__actions">
              {/* 主 CTA：下载（动作 = 陶土橙） */}
              <a className="btn btn--primary btn--lg" href="#download">
                <IconDownload />
                {d.hero.primary}
              </a>
              {/* 次 CTA：浏览器试用 */}
              <a className="btn btn--ghost btn--lg" href={d.links.webApp}>
                {d.hero.secondary}
                <IconArrowRight />
              </a>
            </div>
          </Reveal>

          <Reveal i={4}>
            <div className="hero__trust">
              <span className="muted">{d.hero.trust}</span>
              <span className="pill">{d.hero.note}</span>
            </div>
          </Reveal>
        </div>

        {/* 右列：发光水母主视觉(品牌锚,在后发光供能) + 前置交互式演示卡。
            演示卡是真交互:拖/点切换 skill → 输入 → 回车模拟 Agent 输出,
            直观表达「拖个 skill,任意任务都能交给 Agent」。 */}
        <div className="hero__art">
          {/* halo 呼吸光晕；水母随水流缓慢漂浮(均为氛围,置于卡后) */}
          <span className="halo anim-halo hero__halo" aria-hidden="true" />
          <Jellyfish className="anim-drift hero__jelly" />

          {/* 交互式演示卡 */}
          <div className="hero__demo">
            <HeroDemo d={d} locale={locale} />
          </div>
        </div>
      </div>

      {/* —— scoped 布局 / 入场样式：仅作用于本区块，reduced-motion 下静默 —— */}
      <style>{`
        .hero {
          /* 首屏给足上方留白，避免被 sticky 顶栏遮挡 */
          padding-top: clamp(84px, 12vw, 168px);
          overflow: hidden;
        }
        /* 收一点神经元星点的不透明度，作底纹而非主体 */
        .hero__field { opacity: 0.42; }

        .hero__grid {
          display: grid;
          grid-template-columns: minmax(0, 1.08fr) minmax(0, 0.92fr);
          align-items: center;
          gap: clamp(28px, 5vw, 72px);
        }

        .hero__copy {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: clamp(18px, 2.4vw, 26px);
        }
        /* 比全局 .display 略收一档：避免英文长标题在桌面下排成四行 / 首词落单 */
        .hero__title {
          margin-top: 4px;
          font-size: clamp(2.3rem, 1.4rem + 3.4vw, 4rem);
        }
        /* 荧光点睛词独占一行 */
        .hero__accent { display: block; }
        .hero__lead { max-width: 34em; }

        .hero__actions {
          display: flex;
          flex-wrap: wrap;
          gap: 14px;
        }

        .hero__trust {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px 14px;
          font-size: var(--fs-sm);
        }

        /* 右列主视觉：让水母与光晕居中叠放。
           一次性入场淡入（页面加载即触发，非滚动），保证首屏强锚无空白闪烁。 */
        .hero__art {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: clamp(360px, 44vw, 540px);
          animation: heroArtIn 0.9s var(--ease-out) both;
        }
        @keyframes heroArtIn {
          from { opacity: 0; transform: translateY(8px) scale(0.985); }
          to   { opacity: 1; transform: none; }
        }
        .hero__jelly {
          position: relative;
          z-index: 1;
          width: clamp(280px, 34vw, 440px);
          height: auto;
          /* 水母是卡后氛围:不拦截卡片的拖/点/输入,略降存在感 */
          pointer-events: none;
          opacity: 0.94;
        }
        /* 光晕落在水母之后、向四周柔和扩散 */
        .hero__halo {
          width: clamp(360px, 46vw, 560px);
          height: clamp(360px, 46vw, 560px);
          z-index: 0;
        }

        /* —— 交互式演示卡:底部锚定,压在水母触手上;伞盖在上方完整露出 ——
           (居中会盖住伞盖头部;改为贴底,默认态露出水母主体) */
        .hero__demo {
          position: absolute;
          z-index: 2;
          left: 50%;
          bottom: clamp(0px, 2vw, 20px);
          transform: translateX(-50%);
          width: clamp(300px, 33vw, 384px);
          animation: heroDemoIn 0.9s var(--ease-out) 0.25s both;
        }
        @keyframes heroDemoIn {
          from { opacity: 0; transform: translate(-50%, 14px); }
          to   { opacity: 1; transform: translate(-50%, 0); }
        }

        /* —— 移动端（≤760px）：单列、文在上、水母在下并弱化 —— */
        @media (max-width: 760px) {
          .hero__grid {
            grid-template-columns: 1fr;
            gap: clamp(24px, 7vw, 40px);
          }
          .hero__copy { align-items: flex-start; }
          .hero__actions { width: 100%; }
          /* 移动端:卡片进入正常流(定义高度),水母绝对定位、淡出于卡后 */
          .hero__art {
            order: 2;
            min-height: auto;
            display: block;
            position: relative;
          }
          .hero__jelly {
            position: absolute;
            top: -8px; left: 50%;
            transform: translateX(-50%);
            width: clamp(220px, 60vw, 300px);
            opacity: 0.5;
          }
          .hero__halo {
            width: clamp(280px, 78vw, 380px);
            height: clamp(280px, 78vw, 380px);
            top: 0; left: 50%; transform: translateX(-50%);
          }
          .hero__demo {
            position: relative;
            top: auto; left: auto;
            transform: none;
            margin: clamp(48px, 16vw, 96px) auto 0;
            width: 100%; max-width: 380px;
            animation: none;
          }
        }

        /* .anim-drift / .anim-halo / .reveal 已由 globals.css 的 reduced-motion
           媒体查询静默；本区块新增的 heroArtIn 一次性入场需在此单独屏蔽。 */
        @media (prefers-reduced-motion: reduce) {
          .hero__art { animation: none; }
          .hero__demo { animation: none; }
        }
      `}</style>
    </section>
  );
}
