# Frontend Architecture & Debugging Decisions

## 1. Root-Cause Diagnosis

- **Stream cross-contamination:** `handleSelectEvent` started a fetch and a read loop, but never cancelled it. When you clicked event B, the loop for event A kept running and kept appending to the same `summaryText` state. So both streams wrote into one panel. Whichever finished first also set `isStreaming` to false while the other one was still going.

- **Duplicate fetches & broken history navigation:** Two effects were feeding each other. The first one did `router.push` on every keystroke (no debounce, and also once on mount). The second one copied `searchParams` back into state, which triggered the first effect and the fetch effect again. The fetch wasn't debounced or cancelled, and the API has random delay, so an older response could arrive last and overwrite the newer results. When you pressed Back, the second effect set the old values, and the first effect pushed them again as a new history entry, so Back did nothing useful.

- **Render cascade during streaming:** `summaryText` was state in the top-level page, and the whole page was a client component. Every token (about every 45ms) re-rendered the whole page: the filter bar, all 500 rows, and `HeavyPayloadFormatter`, which takes about 12ms per render and wasn't memoized. That is why typing and scrolling felt slow during streaming.

## 2. Server vs. Client Component Boundaries

**Server Components:** `page.tsx` and `layout.tsx`. The page reads `searchParams`, validates the filters, filters the events on the server and renders the layout (the two columns and the event count). The first load already has the data in the HTML, so there is no fetch on mount. Changing a filter is a normal router navigation, so Next re-renders the page with the new params. The router already handles overlapping navigations (the last one wins), which removes the out-of-order response problem.

**Client Components** (only the parts that need interaction):
- `SelectionProvider`: stores which event is selected, in context.
- `FilterBar`: the inputs, the debounce and `router.push`.
- `EventList` and `EventRow`: clicking a row and highlighting it.
- `SummaryDrawer`: the header and the formatter.
- `StreamingSummary`: owns the stream and its text. This is the only thing that renders per token.
- `HeavyPayloadFormatter`: now memoized.

**Props passed from server to client:** `FilterBar` gets `search` (string) and `severity` (string). `EventList` gets `events` (an array of plain objects with string fields). `SelectionProvider` gets `resetKey` (the query string) and the server-rendered children. No functions or class instances are passed.

I kept `/api/events` as an API endpoint and it uses the same filter function, but the page doesn't call it anymore.

## 3. Stream Cancellation & Race-Condition Strategy

The stream lives in `StreamingSummary`, rendered as `<StreamingSummary key={selected.id} eventId={selected.id} />`. The fetch runs in a `useEffect` that creates its own `AbortController`, and the cleanup calls `abort()`. The cleanup runs whenever the selected event changes, or when the component unmounts (for example when the filters change and the selection is cleared). Aborting cancels the request. The server route checks `request.signal.aborted` and stops, and the pending `reader.read()` throws.

To make sure no old chunks get through:
- After every `reader.read()` I check `signal.aborted` and stop before calling `setText`.
- The text state belongs to that one component instance. Because of the `key`, a new selection always gets a new instance with empty text.

For `AbortError`: the whole async function is inside try/catch. If the signal was aborted, the error is expected and ignored. Any other error shows a "Stream failed" message.

**A → B → A quickly:** Clicking A mounts a component and starts stream 1. Clicking B unmounts it (aborting stream 1) and starts stream 2. Clicking A again unmounts B (aborting stream 2) and mounts a new A component with stream 3. The first A and the second A are different instances with different controllers, so nothing from stream 1 can show up in the new one. React StrictMode in dev mounts, unmounts and mounts again, which goes through the same path, so it's fine.

I tested this in the browser by clicking A, B, A quickly. The panel ended up with only A's report, with one heading and no mixed text.

## 4. State Synchronization & Render Performance

**URL sync without a useEffect loop:** The URL is the source of truth. The server passes `search` and `severity` to `FilterBar` as props. The input keeps a local draft value so typing is instant. Search is pushed to the URL after 300ms without typing (or on Enter). Severity is pushed right away. The push runs inside `startTransition`, so the old list stays usable and a "Loading…" label shows while the new page loads.

There is no effect that copies the URL back into state. Instead, I compare the props during render (the "adjust state when a prop changes" pattern from the React docs):
- If the new URL value is the one we just pushed, I keep the draft as it is (the user might still be typing).
- If it's different, it came from outside (Back/Forward or a pasted link), so the draft takes the URL value.

Nothing writes to the URL as a reaction to the URL changing, so there is no loop. If the new query is the same as the current or already-pending one, I don't push at all, so there are no extra requests. On mount nothing happens, because the data came with the page.

I used `push` instead of `replace` so each finished search becomes one history entry, and Back/Forward step through them. The debounce keeps it to one entry per pause, not one per letter. A `popstate` listener cancels any pending debounce so a late keystroke can't undo a Back. I checked this in the browser: typing "billing" added one history entry, and Back/Forward restored both the list and the input values.

**Checking that tokens don't re-render the table:** I added small render counters to the filter bar, the event list, the drawer and the summary. In the browser, after clicking three events and letting the stream finish, the summary counter was at 61, while the event list was at 4 (the first render plus one per click) and the filter bar stayed at 1. The React DevTools Profiler shows the same: during streaming, only `StreamingSummary` renders.

This works because the streamed text is state inside the small leaf component. The leaf is passed into the memoized formatter as a prop (a React element created by the drawer), so when its state changes, only the leaf re-renders. When the selection changes, the rows are memoized and `select` is a stable callback, so only the two rows whose highlight changed re-render.

(In `next dev` StrictMode renders twice, so the counters go up by 2 there.)
