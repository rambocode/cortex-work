// 落地页 Hero 区（借鉴 kun KunHeroStage）：浏览器窗口 mockup + 居中熟睡的吉祥物 +
// 「开始你的智能体节奏」标题/副标题。纯展示组件,不接数据。
// 吉祥物图借自 kun（占位,后续替换为 Cortex 自有形象）；用 new URL(import.meta.url)
// 取资源 URL —— vite(desktop) 与 webpack/Next(web) 都会重写为 base 正确的资源地址,
// 类型为 string,无需 *.png 环境声明,避免与 Next StaticImageData 冲突。

const mascotSleep = new URL("./assets/mascot-sleep.png", import.meta.url).href;

export function LandingHero() {
  return (
    <section className="pw-hero">
      <div className="pw-hero-stage" aria-hidden="true">
        <div className="pw-hero-shell">
          <div className="pw-hero-titlebar">
            <span className="pw-hero-dot is-red" />
            <span className="pw-hero-dot is-yellow" />
            <span className="pw-hero-dot is-green" />
            <span className="pw-hero-winicon" />
          </div>
          <div className="pw-hero-body">
            <div className="pw-hero-nav">
              <span className="is-active" />
              <span />
              <span />
              <span />
            </div>
            <div className="pw-hero-canvas">
              <span className="pw-hero-thread is-one" />
              <span className="pw-hero-thread is-two" />
              <div className="pw-hero-core">
                <span className="pw-hero-ring" />
                <img className="pw-hero-mascot" src={mascotSleep} alt="Cortex 吉祥物" />
              </div>
              <span className="pw-hero-thread is-three" />
            </div>
          </div>
          <div className="pw-hero-composer">
            <span />
            <span />
          </div>
        </div>
      </div>
      <h1 className="pw-hero-title">开始你的智能体节奏</h1>
      <p className="pw-hero-sub">完成第一轮对话后，这里会自动变成按天累计的用量日历。</p>
    </section>
  );
}
