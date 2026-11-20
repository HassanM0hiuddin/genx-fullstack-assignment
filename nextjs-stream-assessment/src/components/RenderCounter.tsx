"use client";

import { useRef } from "react";

/**
 * Tiny dev aid: shows how many times the component that renders it has rendered.
 * Note: in `next dev` React StrictMode renders twice, so counts move in steps of 2.
 */
export function useRenderCount(): number {
  const count = useRef(0);
  count.current += 1;
  return count.current;
}

export function RenderBadge({ label, count }: { label: string; count: number }) {
  return (
    <span style={{ fontSize: "11px", color: "#64748b", whiteSpace: "nowrap" }}>
      {label} renders: {count}
    </span>
  );
}
