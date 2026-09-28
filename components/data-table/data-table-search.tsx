"use client";

// Search box for a server-paged table. The filtering itself happens on the
// server: this island only writes `?q=` into the URL, 300ms after the last
// keystroke, and the page re-renders with the narrowed query. Every other param
// (sort, filters, page size) is carried through untouched.
//
// `router.replace`, not `push`: every debounced keystroke would otherwise be a
// history entry, and Back would step through "a", "ad", "ada".
import { useEffect, useRef, useState, useTransition } from "react";
import type { KeyboardEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, Search } from "lucide-react";

import { LIST_QUERY_MAX } from "@/lib/list-state";
import { Input } from "@/components/ui/input";

const DEBOUNCE_MS = 300;

interface DataTableSearchProps {
  /** The `q` the server rendered with, already trimmed and capped. */
  query: string;
  /** Accessible name, e.g. "Search users by name or email". */
  label: string;
  placeholder: string;
}

export function DataTableSearch({ query, label, placeholder }: DataTableSearchProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const [value, setValue] = useState<string>(query);
  // The URL can change under the input — Back, or the empty state's "Clear
  // search" link. Adopt that value, unless it is simply the echo of our own
  // navigation arriving (the user may have typed more since).
  const [seenQuery, setSeenQuery] = useState<string>(query);
  const [sentQuery, setSentQuery] = useState<string>(query);
  if (query !== seenQuery) {
    setSeenQuery(query);
    if (query !== sentQuery) {
      setValue(query);
      setSentQuery(query);
    }
  }

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Synchronizing with a timer — cleared on unmount so a late tick never navigates.
  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  function navigate(next: string): void {
    const trimmed = next.trim();
    const params = new URLSearchParams(searchParams.toString());
    if (trimmed) params.set("q", trimmed);
    else params.delete("q");
    // A new search is a new result set: page 3 of the old one means nothing.
    params.delete("page");

    setSentQuery(trimmed);
    const search = params.toString();
    startTransition(() => {
      router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
    });
  }

  function schedule(next: string): void {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      navigate(next);
    }, DEBOUNCE_MS);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Escape" || value === "") return;
    event.preventDefault();
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setValue("");
    navigate("");
  }

  return (
    <div role="search" className="relative w-full sm:w-72">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        maxLength={LIST_QUERY_MAX}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          schedule(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        className="h-11 pr-8 pl-8 sm:h-9"
      />
      {pending ? (
        <Loader2
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
        />
      ) : null}
    </div>
  );
}
