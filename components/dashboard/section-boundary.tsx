"use client";

import { Component, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface SectionBoundaryProps {
  /** What failed, in the reader's terms. Never "an error occurred". */
  title: string;
  /** What to do about it. */
  description: string;
  children: ReactNode;
}

interface SectionBoundaryState {
  hasError: boolean;
}

/**
 * A per-section failure surface.
 *
 * `app/(dashboard)/error.tsx` catches anything that escapes, but a whole-page
 * error screen because one query timed out throws away four working panels. Each
 * section on the overview owns its own boundary, so a failure is contained to
 * the card that could not load and the rest of the dashboard stays usable.
 *
 * Server Components render as `children` of this client component, so errors
 * thrown while streaming them land here.
 */
export class SectionBoundary extends Component<
  SectionBoundaryProps,
  SectionBoundaryState
> {
  state: SectionBoundaryState = { hasError: false };

  static getDerivedStateFromError(): SectionBoundaryState {
    return { hasError: true };
  }

  private readonly handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <SectionErrorCard
          title={this.props.title}
          description={this.props.description}
          onRetry={this.handleRetry}
        />
      );
    }
    return this.props.children;
  }
}

interface SectionErrorCardProps {
  title: string;
  description: string;
  onRetry: () => void;
}

function SectionErrorCard({ title, description, onRetry }: SectionErrorCardProps) {
  const router = useRouter();

  return (
    <Card className="h-full justify-center">
      <CardContent className="flex flex-col items-start gap-3">
        <span className="grid size-8 place-items-center rounded-md bg-destructive/10 text-destructive">
          <TriangleAlert className="size-4" aria-hidden />
        </span>
        <div className="flex flex-col gap-1">
          <h3 className="font-heading text-sm font-semibold tracking-tight">{title}</h3>
          <p className="text-xs text-muted-foreground text-balance">{description}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-11 px-3 sm:h-7 sm:px-2.5"
          onClick={() => {
            // Clear the boundary, then ask the server for a fresh render — one
            // without the other just re-shows the same broken tree.
            onRetry();
            router.refresh();
          }}
        >
          <RotateCcw aria-hidden />
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
