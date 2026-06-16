import type { Metadata } from "next";
import { notFound } from "next/navigation";
import "../globals.css";
import { locales, isLocale, type Locale } from "@/lib/i18n";
import { getDict } from "@/lib/dictionary";

// 站点地址（占位：部署时用 NEXT_PUBLIC_SITE_URL 覆盖为真实域名）。
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://cortex-desktop.app";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export const dynamicParams = false;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const loc: Locale = isLocale(locale) ? locale : "zh";
  const d = getDict(loc);
  return {
    metadataBase: new URL(SITE_URL),
    title: d.meta.title,
    description: d.meta.description,
    alternates: {
      canonical: `/${loc}`,
      languages: { zh: "/zh", en: "/en", "x-default": "/zh" },
    },
    openGraph: {
      type: "website",
      siteName: d.brand.name,
      title: d.meta.title,
      description: d.meta.description,
      url: `/${loc}`,
      locale: loc === "zh" ? "zh_CN" : "en_US",
    },
    twitter: { card: "summary_large_image", title: d.meta.title, description: d.meta.description },
  };
}

// 主题防闪烁：渲染前根据 localStorage / 系统偏好设定 data-theme。
const themeBootstrap = `(function(){try{var k='cortex-theme';var t=localStorage.getItem(k);var dark=window.matchMedia('(prefers-color-scheme: dark)').matches;var theme=(t==='light'||t==='dark')?t:(dark?'dark':'light');document.documentElement.dataset.theme=theme;}catch(e){}})();`;

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        {/* 跳到主内容：键盘聚焦时显形，跳过顶栏直达 <main id="main"> */}
        <a className="skip-link" href="#main">
          {d.a11y.skipToContent}
        </a>
        {children}
      </body>
    </html>
  );
}
