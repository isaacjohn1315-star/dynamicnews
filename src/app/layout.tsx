import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "DynaSport — Football News Operations",
  description:
    "Production monitoring for the DynaSport pipeline: NewsData.io football-news discovery, relevance filtering, duplicate protection, and automated publishing to the DynaSport Facebook Page.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#070b08] text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
