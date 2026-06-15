/* =========================================================================
   FinalCTA · 收尾大 CTA（<section id="download">）
   居中、视觉强一档：荧光描边大卡（复刻 .pill--glow 的渐变描边手法）+ 背后光晕，
   内部居中标题（关键词 glow-text）/ 支撑句 / 双 CTA / 底部小字。
   server 组件：无 hooks、不读浏览器 API；动效全部走 .reveal / .halo（已含 reduced-motion 兜底）。
   ========================================================================= */

import Link from "next/link";

import { IconDownload, IconGithub } from "@/components/icons";
import { Reveal } from "@/components/ui";
import type { Dict } from "@/lib/dictionary";
import type { Locale } from "@/lib/i18n";

export default function FinalCTA({ d }: { d: Dict; locale: Locale }) {
  return (
    <section id="download" className="section">
      <div className="container container-narrow">
        <Reveal>
          {/* 大卡：用 --grad-jelly 做 border-box 渐变描边（同 .pill--glow 手法），
              内层 paper 面 padding-box 盖住，得到一圈荧光勾边。 */}
          <div
            style={{
              position: "relative",
              borderRadius: "var(--r-xl)",
              padding: "1px", // 描边厚度
              background: "var(--grad-jelly)",
              boxShadow: "var(--shadow-pop)",
              overflow: "hidden",
            }}
          >
            {/* 背后单枚柔和光晕作主光（荧光点睛而非满溢；halo 自带 reduced-motion 友好的静态渐变） */}
            <span
              className="halo"
              aria-hidden="true"
              style={{ width: 460, height: 460, top: "-34%", left: "50%", transform: "translateX(-50%)" }}
            />

            {/* 内层纸面：居中内容 */}
            <div
              className="content"
              style={{
                position: "relative",
                background: "var(--paper-raise)",
                borderRadius: "calc(var(--r-xl) - 1px)",
                padding: "clamp(40px, 6vw, 72px) clamp(22px, 5vw, 56px)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                textAlign: "center",
                gap: 18,
              }}
            >
              <h2 className="h2" style={{ textWrap: "balance", maxWidth: "18ch" }}>
                <span className="glow-text">{d.finalCta.title}</span>
              </h2>

              <p className="lead" style={{ textWrap: "balance", maxWidth: "46ch" }}>
                {d.finalCta.sub}
              </p>

              {/* 双 CTA：主操作下载（clay）+ 次操作 GitHub（ghost，外链新窗口） */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "center",
                  gap: 14,
                  marginTop: 6,
                }}
              >
                <Link className="btn btn--primary btn--lg" href={d.links.releases}>
                  <IconDownload />
                  {d.finalCta.primary}
                </Link>
                <Link
                  className="btn btn--ghost btn--lg"
                  href={d.links.github}
                  target="_blank"
                  rel="noreferrer"
                >
                  <IconGithub />
                  {d.finalCta.secondary}
                </Link>
              </div>

              <p className="muted" style={{ fontSize: "var(--fs-sm)", marginTop: 4 }}>
                {d.finalCta.note}
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
