"use client";

import React, { memo, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { filtersToQuery, type SeverityFilter } from "@/lib/filters";
import { RenderBadge, useRenderCount } from "./RenderCounter";

const SEARCH_DEBOUNCE_MS = 300;

const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: "6px",
  border: "1px solid #334155",
  background: "#1e293b",
  color: "#f8fafc",
};

/**
 * The URL is the source of truth; `search` / `severity` props come from the Server
 * Component's searchParams. The inputs keep a local *draft* so typing stays instant,
 * and the draft is pushed to the URL (debounced for search, immediate for severity).
 *
 * There is no URL -> state useEffect. When the URL props change we reconcile during
 * render: if the new URL value is the one we just pushed ourselves, the draft is left
 * alone (the user may have kept typing); otherwise the change came from outside
 * (Back/Forward, a pasted link) and the draft adopts the URL value.
 */
function FilterBarImpl({ search, severity }: { search: string; severity: SeverityFilter }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const renders = useRenderCount();

  const [searchDraft, setSearchDraft] = useState(search);
  const [severityDraft, setSeverityDraft] = useState<SeverityFilter>(severity);

  // Last URL values we have reconciled against, and the query we most recently pushed.
  const [seenUrl, setSeenUrl] = useState({ search, severity });
  const [pushedQuery, setPushedQuery] = useState<string | null>(null);

  if (search !== seenUrl.search || severity !== seenUrl.severity) {
    setSeenUrl({ search, severity });
    const incoming = filtersToQuery({ search, severity });
    if (incoming === pushedQuery) {
      setPushedQuery(null); // our own navigation landed: keep the draft as is
    } else {
      setSearchDraft(search); // external navigation: follow the URL
      setSeverityDraft(severity);
      setPushedQuery(null);
    }
  }

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelDebounce = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);
  useEffect(() => cancelDebounce, [cancelDebounce]);

  // Back/Forward must win over a still-pending debounced keystroke.
  useEffect(() => {
    window.addEventListener("popstate", cancelDebounce);
    return () => window.removeEventListener("popstate", cancelDebounce);
  }, [cancelDebounce]);

  const commit = useCallback(
    (next: { search: string; severity: SeverityFilter }) => {
      cancelDebounce();
      const query = filtersToQuery(next);
      // Where the URL is (or is about to be): skip navigations that would change nothing, so no duplicate server render.
      const target = pushedQuery ?? filtersToQuery({ search, severity });
      if (query === target) return;
      setPushedQuery(query);
      startTransition(() => {
        // push (not replace): every settled filter state becomes a history entry,
        // so Back/Forward step through them. Debouncing keeps it to one entry per pause.
        router.push(`${pathname}${query}`, { scroll: false });
      });
    },
    [cancelDebounce, pathname, pushedQuery, router, search, severity]
  );

  // The debounced timer must call the *latest* commit (fresh props / pushedQuery), not the one from the keystroke's render.
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });

  function onSearchChange(value: string) {
    setSearchDraft(value);
    cancelDebounce();
    debounceRef.current = setTimeout(
      () => commitRef.current({ search: value, severity: severityDraft }),
      SEARCH_DEBOUNCE_MS
    );
  }

  function onSeverityChange(value: SeverityFilter) {
    setSeverityDraft(value);
    commit({ search: searchDraft, severity: value });
  }

  return (
    <div style={{ padding: "16px", borderBottom: "1px solid #1e293b", display: "flex", gap: "12px", alignItems: "center" }}>
      <input
        type="search"
        value={searchDraft}
        onChange={(e) => onSearchChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit({ search: searchDraft, severity: severityDraft });
        }}
        placeholder="Filter by service, title, or ID..."
        aria-label="Search events"
        style={{ ...inputStyle, flex: 1 }}
      />
      <select
        value={severityDraft}
        onChange={(e) => onSeverityChange(e.target.value as SeverityFilter)}
        aria-label="Severity"
        style={inputStyle}
      >
        <option value="all">All Severities</option>
        <option value="info">Info</option>
        <option value="warning">Warning</option>
        <option value="critical">Critical</option>
      </select>
      <span style={{ fontSize: "12px", color: "#38bdf8", minWidth: "60px" }}>{isPending ? "Loading…" : ""}</span>
      <RenderBadge label="Filter bar" count={renders} />
    </div>
  );
}

export const FilterBar = memo(FilterBarImpl);
