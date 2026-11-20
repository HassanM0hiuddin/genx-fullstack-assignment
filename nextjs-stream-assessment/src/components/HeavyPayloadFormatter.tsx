"use client";

import React, { memo } from "react";

/**
 * Simulates an expensive markdown / syntax highlighting component (~12ms per render).
 *
 * Memoised, and the streamed text is no longer a prop: it arrives as a `summary` slot
 * (a React element created by the parent). The element owns its own state, so token
 * updates re-render only that element, never this formatter.
 */
function HeavyPayloadFormatterImpl({ rawPayload, summary }: { rawPayload: string; summary: React.ReactNode }) {
  // Simulate ~12ms of synchronous formatting work per render
  const start = performance.now();
  let checksum = 0;
  while (performance.now() - start < 12) {
    checksum = (checksum + 1) % 1000;
  }

  return (
    <div data-checksum={checksum} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div
        style={{
          background: "#1e293b",
          padding: "14px",
          borderRadius: "8px",
          border: "1px solid #334155",
          whiteSpace: "pre-wrap",
          lineHeight: 1.55,
          minHeight: "180px",
        }}
      >
        {summary}
      </div>
      <details open>
        <summary style={{ cursor: "pointer", color: "#94a3b8", fontSize: "13px" }}>Raw Telemetry Payload</summary>
        <pre
          style={{
            background: "#020617",
            padding: "12px",
            borderRadius: "6px",
            fontSize: "12px",
            overflowX: "auto",
          }}
        >
          {rawPayload}
        </pre>
      </details>
    </div>
  );
}

export const HeavyPayloadFormatter = memo(HeavyPayloadFormatterImpl);
