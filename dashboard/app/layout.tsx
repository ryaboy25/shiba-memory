import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Shiba Memory — Brain Dashboard",
  description: "3D neural visualization of your AI agent memory",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistMono.variable} h-full dark`}>
      <body className="h-full bg-[#0a0a0f] text-white overflow-hidden">{children}</body>
    </html>
  );
}
