import type { Metadata, Viewport } from "next";
import { Heebo } from "next/font/google";
import "./globals.css";

// Heebo covers Hebrew and Latin, so mixed medical text (Hebrew prose, Latin drug and
// test names) renders in one typeface instead of falling back mid-sentence.
const heebo = Heebo({
  variable: "--font-heebo",
  subsets: ["hebrew", "latin"],
});

export const metadata: Metadata = {
  title: "HealthApp",
  description: "ניהול מסמכים רפואיים, תורים והתנהלות מול קופת חולים",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl" className={`${heebo.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-neutral-50 text-neutral-900 font-[family-name:var(--font-heebo)]">
        {children}
      </body>
    </html>
  );
}
