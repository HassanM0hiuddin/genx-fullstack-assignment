"use client";

import React from "react";
import { useSelection } from "./SelectionProvider";
import { HeavyPayloadFormatter } from "./HeavyPayloadFormatter";
import { StreamingSummary } from "./StreamingSummary";
import { RenderBadge, useRenderCount } from "./RenderCounter";

/**
 * Re-renders only on selection change. The streamed text is owned by the
 * StreamingSummary leaf, which is passed into the (memoised) formatter as a slot.
 */
export function SummaryDrawer() {
  const { selected } = useSelection();
  const renders = useRenderCount();

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <h2 style={{ margin: 0, fontSize: "18px" }}>{selected ? `Analysis: ${selected.id}` : "Incident Summary"}</h2>
        <RenderBadge label="Drawer" count={renders} />
      </div>

      <HeavyPayloadFormatter
        rawPayload={selected?.rawPayload ?? "{}"}
        summary={
          selected ? (
            // key = event id: a new selection mounts a fresh leaf with empty state, and the
            // old leaf's effect cleanup aborts its request. A -> B -> A gets three separate streams.
            <StreamingSummary key={selected.id} eventId={selected.id} />
          ) : (
            <span style={{ color: "#94a3b8" }}>Select an event to generate an AI incident analysis...</span>
          )
        }
      />
    </>
  );
}
