"use client";

// The last line of defence: an error in the root layout itself, where no other
// error boundary can render. It replaces the whole document, so it brings its
// own <html> and minimal inline styling (the app's CSS may be what failed).
// The error is already logged on the server (instrumentation.ts).
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f8f9fb", color: "#1c1b19" }}>
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, textAlign: "center" }}>
          <div>
            <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Meridian couldn&apos;t load</h1>
            <p style={{ margin: "0 0 20px", color: "#5c5a54", fontSize: 14 }}>
              Something went wrong on our side. Try again; if it keeps happening, come back in a few minutes.
            </p>
            <button
              type="button"
              onClick={reset}
              style={{ padding: "10px 18px", borderRadius: 8, border: 0, background: "#1c1b19", color: "#fff", fontSize: 14, cursor: "pointer" }}
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
