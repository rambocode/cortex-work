import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cortex Desktop",
  description: "团队 Agent 桌面端 · Web",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // lang 默认 zh-Hans;运行时由 applyTweaksToDom 客户端更新 documentElement.lang。
  return (
    <html lang="zh-Hans">
      <body>{children}</body>
    </html>
  );
}
