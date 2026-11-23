// The public footer: landing page, privacy and terms. Server Component.
import Link from "next/link";

import { BrandMark } from "@/components/dashboard/brand-mark";
import { SITE } from "@/lib/site";

const LINKS: readonly { href: string; label: string }[] = [
  { href: "/docs/api", label: "API docs" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: SITE.repository, label: "Source" },
  { href: "/sign-in", label: "Sign in" },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-muted-foreground sm:px-6">
        <BrandMark />
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
          {LINKS.map((link) =>
            link.href.startsWith("http") ? (
              <a key={link.href} href={link.href} target="_blank" rel="noreferrer" className="hover:text-foreground">
                {link.label}
              </a>
            ) : (
              <Link key={link.href} href={link.href} className="hover:text-foreground">
                {link.label}
              </Link>
            ),
          )}
        </nav>
      </div>
    </footer>
  );
}
