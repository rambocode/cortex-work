import { isLocale, type Locale } from "@/lib/i18n";
import { getDict } from "@/lib/dictionary";

import Nav from "@/components/sections/Nav";
import Hero from "@/components/sections/Hero";
import Agents from "@/components/sections/Agents";
import SkillShowcase from "@/components/sections/SkillShowcase";
import NotesShowcase from "@/components/sections/NotesShowcase";
import Features from "@/components/sections/Features";
import Automation from "@/components/sections/Automation";
import FinalCTA from "@/components/sections/FinalCTA";
import Footer from "@/components/sections/Footer";
import { Reveal } from "@/components/ui";

/* =========================================================================
   落地页装配（async server 组件）
   叙事：Hero 总承诺 → Agents（任意 Agent）→ Skills（默认不膨胀·省 token，差异化核心）
   → 闪记（随手接住灵感）→ Features（能力广度）→ Automation（无人值守）→ FinalCTA。
   - Hero 首屏直接显示；其余区块用 <Reveal> 进入视口揭示。
   - 锚点 id 全站唯一：skills / notes / features / agents / download。
   ========================================================================= */
export default async function LandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const loc: Locale = isLocale(locale) ? locale : "zh";
  const d = getDict(loc);

  return (
    <>
      <Nav d={d} locale={loc} />
      <main id="main">
        {/* 首屏直接显示，自身已做错峰入场，无需再包 Reveal */}
        <Hero d={d} locale={loc} />

        <Reveal>
          <Agents d={d} locale={loc} />
        </Reveal>
        <Reveal>
          <SkillShowcase d={d} locale={loc} />
        </Reveal>
        <Reveal>
          <NotesShowcase d={d} locale={loc} />
        </Reveal>
        <Reveal>
          <Features d={d} locale={loc} />
        </Reveal>
        <Reveal>
          <Automation d={d} locale={loc} />
        </Reveal>
        <Reveal>
          <FinalCTA d={d} locale={loc} />
        </Reveal>
      </main>
      <Footer d={d} locale={loc} />
    </>
  );
}
