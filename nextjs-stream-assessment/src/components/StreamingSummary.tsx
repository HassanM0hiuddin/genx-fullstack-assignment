"use client";

import React, { useEffect, useState } from "react";
import { RenderBadge, useRenderCount } from "./RenderCounter";

type StreamStatus = "connecting" | "streaming" | "done" | "error";

/**
 * Leaf component that owns one stream. It is the only component that re-renders per token.
 *
 * Cancellation: every effect run creates its own AbortController and the cleanup aborts
 * it. Cleanup runs when eventId changes, when the parent remounts us with a new key, or
 * when we unmount (selection cleared by a filter change). An aborted fetch makes
 * `reader.read()` reject with AbortError, which we swallow, and the `signal.aborted`
 * checks guarantee that no chunk from a cancelled stream is ever written to state.
 */
export function StreamingSummary({ eventId }: { eventId: string }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const renders = useRenderCount();

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setText("");
    setStatus("connecting");

    (async () => {
      try {
        const res = await fetch(`/api/stream-summary?eventId=${encodeURIComponent(eventId)}`, {
          signal,
          cache: "no-store",
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        if (!signal.aborted) setStatus("streaming");

        while (true) {
          const { done, value } = await reader.read();
          if (signal.aborted) return;
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          setText((prev) => prev + chunk);
        }
        const tail = decoder.decode();
        if (tail) setText((prev) => prev + tail);
        setStatus("done");
      } catch (err) {
        if (signal.aborted) return; // expected: a newer selection superseded this stream
        console.error("Summary stream failed", err);
        setStatus("error");
      }
    })();

    return () => controller.abort();
  }, [eventId]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", fontSize: "12px" }}>
        <span style={{ color: status === "error" ? "#f87171" : "#38bdf8" }}>
          {status === "connecting" && "Connecting…"}
          {status === "streaming" && "Streaming tokens..."}
          {status === "error" && "Stream failed. Select the event again to retry."}
        </span>
        <RenderBadge label="Summary" count={renders} />
      </div>
      <div aria-live="polite">{text}</div>
    </div>
  );
}
