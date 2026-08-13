import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TaskCenter | 本地任务工作台",
  description: "按 Codex 任务审计本地需求实现状态的独立工作台。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
