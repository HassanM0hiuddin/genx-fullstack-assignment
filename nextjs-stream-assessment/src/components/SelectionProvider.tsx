"use client";

import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { SystemEvent } from "@/lib/mockData";

interface SelectionContextValue {
  selected: SystemEvent | null;
  select: (evt: SystemEvent) => void;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

/**
 * Holds only *which* event is selected. Streaming text deliberately does not live here:
 * it is owned by the StreamingSummary leaf so token updates never reach the list.
 */
export function SelectionProvider({ resetKey, children }: { resetKey: string; children: React.ReactNode }) {
  const [selected, setSelected] = useState<SystemEvent | null>(null);

  // "Adjust state when a prop changes" during render (no effect, no extra commit):
  // when the filters change, drop the selection so the active stream is unmounted/aborted.
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setSelected(null);
  }

  const select = useCallback((evt: SystemEvent) => setSelected(evt), []);
  const value = useMemo(() => ({ selected, select }), [selected, select]);

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("useSelection must be used inside <SelectionProvider>");
  return ctx;
}
