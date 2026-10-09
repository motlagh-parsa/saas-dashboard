import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import { ToastRegion } from "@/components/dashboard/toast-region";
import { WebVitals } from "@/components/web-vitals";
import { THEME_COOKIE, parseTheme, themeClass } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Display / heading voice — an engineered grotesk that reads like an instrument.
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Meridian — SaaS metrics",
    template: "%s — Meridian",
  },
  description:
    "The operational control center for SaaS revenue: MRR, churn, and growth in one fast, legible surface.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The theme class is decided HERE, from the `meridian_theme` cookie, so the
  // first byte of HTML already carries it — no inline script, no flash. "system"
  // renders no class and globals.css follows `prefers-color-scheme` (lib/theme.ts).
  //
  // Reading a cookie makes every route render dynamically. That is the price of
  // a server-decided theme; the alternative is a pre-paint script.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <html
      lang="en"
      // The server and the client now agree on this class. Kept only because
      // browser extensions (e.g. Dark Reader) write attributes on <html>.
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} ${themeClass(theme)} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ToastRegion />
        <WebVitals />
        {children}
      </body>
    </html>
  );
}
