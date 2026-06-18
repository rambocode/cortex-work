import { isLocale, type Locale } from "@/lib/i18n";
import { getDict } from "@/lib/dictionary";

import Nav from "@/components/sections/Nav";
import Hero from "@/components/sections/Hero";
import Agents from "@/components/sections/Agents";
import SkillShowcase from "@/components/sections/SkillShowcase";
import AccountingShowcase from "@/components/sections/AccountingShowcase";
import NotesShowcase from "@/components/sections/NotesShowcase";
import TerminalShowcase from "@/components/sections/TerminalShowcase";
import Features from "@/components/sections/Features";
import Automation from "@/components/sections/Automation";
import FinalCTA from "@/components/sections/FinalCTA";
import Footer from "@/components/sections/Footer";
import { Reveal } from "@/components/ui";

/* =========================================================================
   落地页装配（async server 组件）
   叙事：Hero 总承诺(双主线:写代码 / 记一笔账,拖 skill 按需注入)
   → Skills(拖动 skill·省 token,核心机制) → 会计录入(拖入 skill 示例)
   → 闪记(随手接住灵感) → 终端(文件/代码点击即引用进 Agent 输入框)
   → Agents(任意 Agent) → Features(能力广度) → Automation(无人值守) → FinalCTA。
   - Hero 首屏直接显示；其余区块用 <Reveal> 进入视口揭示。
   - 锚点 id 全站唯一：skills / accounting / notes / terminal / agents / features / download。
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
          <SkillShowcase d={d} locale={loc} />
        </Reveal>
        <Reveal>
          <AccountingShowcase d={d} locale={loc} />
        </Reveal>
        <Reveal>
          <NotesShowcase d={d} locale={loc} />
        </Reveal>
        <Reveal>
          <TerminalShowcase d={d} locale={loc} />
        </Reveal>
        <Reveal>
          <Agents d={d} locale={loc} />
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
