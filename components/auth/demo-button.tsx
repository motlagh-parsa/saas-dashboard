"use client";

// "Try the demo" — signs in as the shared demo account in one click. Rendered
// only when the deployment runs a public demo (lib/env.ts → isPublicDemo); the
// "demo" sign-in provider doesn't exist otherwise.
import { useState } from "react";
import { signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

export function DemoButton({ className, variant = "outline" }: { className?: string; variant?: "outline" | "default" }) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      type="button"
      variant={variant}
      className={className}
      aria-disabled={pending ? "true" : undefined}
      onClick={() => {
        if (pending) return;
        setPending(true);
        void signIn("demo", { callbackUrl: "/dashboard" });
      }}
    >
      {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
      Try the demo
    </Button>
  );
}
