// The shell for /privacy and /terms: the landing page's header and footer
// around a single readable column. A Server Component — the pages are static
// text, and the theme toggle is its own client leaf.
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";

import { BrandMark } from "@/components/dashboard/brand-mark";
import { ThemeToggle } from "@/components/dashboard/theme-toggle";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SITE } from "@/lib/site";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";

interface LegalPageProps {
  readonly title: string;
  readonly summary: string;
  readonly children: ReactNode;
}

export async function LegalPage({ title, summary, children }: LegalPageProps) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const updated = new Date(`${SITE.legalUpdated}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link
            href="/"
            aria-label="Meridian home"
            className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <BrandMark />
          </Link>
          <ThemeToggle theme={theme} />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 sm:py-16">
        <p className="font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase">
          Last updated {updated}
        </p>
        <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        <p className="mt-4 text-lg leading-relaxed text-muted-foreground">{summary}</p>
        <div className="mt-10 flex flex-col gap-10">{children}</div>
      </main>

      <SiteFooter />
    </div>
  );
}

interface LegalSectionProps {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}

/** One numbered-by-order section: a heading and its paragraphs or lists. */
export function LegalSection({ id, title, children }: LegalSectionProps) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 leading-relaxed text-foreground/90">
      <h2 id={id} className="font-heading text-xl font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A plain bulleted list in the section's text style. */
export function LegalList({ items }: { readonly items: readonly ReactNode[] }) {
  return (
    <ul className="flex flex-col gap-2 pl-5 [&>li]:list-disc [&>li]:marker:text-muted-foreground">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

/** An inline link styled for running text. */
export function TextLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  const className = "font-medium text-foreground underline underline-offset-4 hover:text-brand";
  return href.startsWith("http") ? (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
