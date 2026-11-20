"use client";

import React, { memo } from "react";
import type { SystemEvent } from "@/lib/mockData";
import { useSelection } from "./SelectionProvider";
import { RenderBadge, useRenderCount } from "./RenderCounter";

const SEVERITY_BG: Record<SystemEvent["severity"], string> = {
  critical: "#7f1d1d",
  warning: "#78350f",
  info: "#1e3a8a",
};

/**
 * Re-renders only when the event list (server props) or the selection changes.
 * Streaming tokens live in StreamingSummary and never reach this component.
 * Rows are memoised too, so a selection change re-renders just the two affected rows.
 */
function EventListImpl({ events }: { events: SystemEvent[] }) {
  const { selected, select } = useSelection();
  const renders = useRenderCount();
  const selectedId = selected?.id;

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <div style={{ padding: "4px 16px", textAlign: "right" }}>
        <RenderBadge label="Event list" count={renders} />
      </div>
      {events.length === 0 && <div style={{ padding: "12px 16px", color: "#94a3b8" }}>No events match these filters.</div>}
      {events.map((evt) => (
        <EventRow key={evt.id} evt={evt} isSelected={evt.id === selectedId} onSelect={select} />
      ))}
    </div>
  );
}

export const EventList = memo(EventListImpl);

const EventRow = memo(function EventRow({
  evt,
  isSelected,
  onSelect,
}: {
  evt: SystemEvent;
  isSelected: boolean;
  onSelect: (evt: SystemEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(evt)}
      aria-pressed={isSelected}
      style={{
        all: "unset",
        boxSizing: "border-box",
        width: "100%",
        padding: "12px 16px",
        borderBottom: "1px solid #1e293b",
        cursor: "pointer",
        background: isSelected ? "#1e293b" : "transparent",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <div>
        <div style={{ fontSize: "14px", fontWeight: 500 }}>{evt.title}</div>
        <div style={{ fontSize: "12px", color: "#64748b" }}>
          {evt.id} · {evt.timestamp}
        </div>
      </div>
      <span
        style={{
          fontSize: "11px",
          padding: "2px 8px",
          borderRadius: "999px",
          background: SEVERITY_BG[evt.severity],
          color: "#f8fafc",
        }}
      >
        {evt.severity}
      </span>
    </button>
  );
});
