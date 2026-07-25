"use client";

// Client leaf: the only interactive part of the sign-in page. It calls NextAuth's
// client `signIn` directly against /api/auth/* — no bespoke POST endpoint, no
// SessionProvider needed.
import * as React from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type SignInFormProps = {
  callbackUrl: string;
  githubEnabled: boolean;
  initialError?: string;
};

function humanizeError(code: string): string {
  switch (code) {
    case "CredentialsSignin":
      return "Invalid email or password.";
    case "OAuthAccountNotLinked":
      return "That email is already linked to a different sign-in method.";
    default:
      return "Something went wrong signing in. Please try again.";
  }
}

export function SignInForm({
  callbackUrl,
  githubEnabled,
  initialError,
}: SignInFormProps) {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(
    initialError ? humanizeError(initialError) : null,
  );

  async function onCredentialsSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
      callbackUrl,
    });

    if (!result || result.error) {
      setError(humanizeError(result?.error ?? "Default"));
      setPending(false);
      return;
    }

    router.push(result.url ?? callbackUrl);
    router.refresh();
  }

  async function onGithubSignIn() {
    setPending(true);
    setError(null);
    // OAuth is a full-page redirect flow, so let NextAuth handle navigation.
    await signIn("github", { callbackUrl });
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      <form onSubmit={onCredentialsSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={pending}
            className="h-11"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending}
            className="h-11"
          />
        </div>

        <Button
          type="submit"
          disabled={pending}
          className="mt-1 h-11 w-full bg-brand text-brand-foreground hover:bg-brand/90"
        >
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      {githubEnabled ? (
        <>
          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={onGithubSignIn}
            disabled={pending}
            className="h-11 w-full"
          >
            Continue with GitHub
          </Button>
        </>
      ) : null}
    </div>
  );
}