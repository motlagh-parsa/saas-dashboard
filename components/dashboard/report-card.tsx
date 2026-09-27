"use client";

// One card of the report catalogue. Client, because "Generate" owns state that
// shows up in two places on the card — the button's pending state in the header
// and the "Last generated" line in the footer — so the smallest component that
// can own both is the card itself. The page stays a Server Component and hands
// the icon over already rendered, since a component function cannot cross the
// server/client boundary as a prop.
//
// "Generate" POSTs to /api/reports/[reportId]/generate, which records a
// `ReportRun` row. On success the footer reads "Just now".
//
// The initial footer text arrives FINISHED from the server: a relative time for
// the latest real run, or the catalogue's "Never" for a report never run.
// Nothing here formats against the clock, so the server render and the
// hydration render cannot disagree about what "2 minutes ago" says.
import { useState } from "react";
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { toast } from "@/components/dashboard/use-toast";

/** What the footer reads once a run has finished in this session. */
const JUST_NOW = "Just now";

/** Footnote voice — same as the page's card footers and table closing line. */
const FOOTNOTE = "text-[0.6875rem] text-muted-foreground";

interface ReportCardProps {
  /** Catalogue key (`ReportDefinition.id`) — the route segment the run is recorded under. */
  reportId: string;
  name: string;
  description: string;
  /**
   * Footer text as the server rendered it: relative time of the latest run, or
   * the catalogue's display string when the report has never been run.
   */
  initialLastGenerated: string;
  /**
   * The latest run's instant, when there is one. Only feeds `<time dateTime>` —
   * the visible text is `initialLastGenerated`. Null or absent means the footer
   * is catalogue copy, which has no real datetime to put in the attribute.
   */
  lastGeneratedAt?: Date | null;
  /** Pre-rendered, decorative (`aria-hidden`) report mark. */
  icon: ReactNode;
}

interface LastGenerated {
  readonly label: string;
  readonly at: Date | null;
}

export function ReportCard({
  reportId,
  name,
  description,
  initialLastGenerated,
  lastGeneratedAt = null,
  icon,
}: ReportCardProps) {
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [lastGenerated, setLastGenerated] = useState<LastGenerated>({
    label: initialLastGenerated,
    at: lastGeneratedAt,
  });

  async function handleGenerate(): Promise<void> {
    if (isGenerating) return;
    setIsGenerating(true);
    try {
      const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}/generate`, {
        method: "POST",
      });

      // `requireSession()` redirects an expired session to /sign-in, and fetch
      // follows it — so a redirect here means "signed out", and the 200 it ends
      // on is the sign-in page, not a recorded run.
      if (res.redirected) {
        window.location.assign(res.url);
        return;
      }

      if (res.ok) {
        setLastGenerated({ label: JUST_NOW, at: new Date() });
        toast.success("Report generated successfully", { description: name });
      } else if (res.status === 403) {
        // Signed in, but no workspace — sending them to sign-in would not help.
        toast.error("Failed to generate report", {
          description: "This account is not a member of any workspace.",
        });
      } else {
        toast.error("Failed to generate report", { description: name });
      }
    } catch {
      toast.error("Failed to generate report", { description: name });
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <Card size="sm" className="h-full gap-2.5">
      <CardHeader>
        <div className="flex items-center gap-2">
          {icon}
          {/*
            Sentence case, not the mono-caps eyebrow. A report is a NAMED
            ARTIFACT, like an invoice or a member — mono caps is reserved for
            labels and panel subjects. It also keeps four titles legible at the xl
            column width.
          */}
          <h2 className="font-heading text-[0.8125rem] leading-snug font-medium text-foreground">
            {name}
          </h2>
        </div>

        <CardAction>
          {/* Outline, not brass: four gold buttons in a row would spend the
              page's one accent on its least important action. The accessible
              name carries the report so four "Generate" buttons are distinct
              when read out of context. */}
          <Button
            type="button"
            variant="outline"
            className="h-11 px-3 sm:h-8"
            onClick={handleGenerate}
            disabled={isGenerating}
            aria-busy={isGenerating}
            aria-label={`${isGenerating ? "Generating" : "Generate"} ${name}`}
          >
            {isGenerating ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {isGenerating ? "Generating…" : "Generate"}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent>
        <p className="text-xs leading-relaxed text-muted-foreground text-balance">
          {description}
        </p>
      </CardContent>

      {/* mt-auto pins the timestamp to the bottom so the four footers form one
          line across the row, whatever height the descriptions take. */}
      <CardFooter className={cn("mt-auto justify-between gap-2", FOOTNOTE)}>
        <span>Last generated</span>
        {/* No instant means never run: the catalogue's "Never" is an absence,
            not a value, so it drops to the muted voice instead of wearing the
            same mono figure as a real run time. */}
        {lastGenerated.at === null ? (
          <span className="text-muted-foreground">{lastGenerated.label}</span>
        ) : (
          <time
            dateTime={lastGenerated.at.toISOString()}
            className="font-mono text-foreground"
          >
            {lastGenerated.label}
          </time>
        )}
      </CardFooter>
    </Card>
  );
}
