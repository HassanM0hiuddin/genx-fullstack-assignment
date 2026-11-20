/**
 * Server Component. Reads the filters from the URL, filters the dataset on the server
 * and renders the static shell. Only the interactive leaves are Client Components:
 *   - FilterBar        (inputs, debounced URL updates)
 *   - EventList        (row click -> selection)
 *   - SummaryDrawer    (selected event + streaming leaf)
 *   - SelectionProvider (shares the selected event between list and drawer)
 *
 * Changing a filter is a normal App Router navigation (router.push), so the router
 * re-runs this component with the new searchParams. There is no client-side fetch of
 * the event list at all, which removes the duplicate fetches and the out-of-order
 * response race of the original implementation.
 */

import { ALL_EVENTS } from "@/lib/mockData";
import { filterEvents, filtersToQuery, parseFilters } from "@/lib/filters";
import { FilterBar } from "@/components/FilterBar";
import { EventList } from "@/components/EventList";
import { SelectionProvider } from "@/components/SelectionProvider";
import { SummaryDrawer } from "@/components/SummaryDrawer";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const filters = parseFilters(await searchParams);
  const events = filterEvents(ALL_EVENTS, filters);

  return (
    // resetKey: a filter change clears the selection, which unmounts (and aborts) any active stream.
    <SelectionProvider resetKey={filtersToQuery(filters)}>
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", height: "100vh", overflow: "hidden" }}>
        <section
          style={{ borderRight: "1px solid #1e293b", display: "flex", flexDirection: "column", overflow: "hidden" }}
        >
          <FilterBar search={filters.search} severity={filters.severity} />
          <div style={{ padding: "6px 16px", fontSize: "12px", color: "#64748b", borderBottom: "1px solid #1e293b" }}>
            {events.length} of {ALL_EVENTS.length} events
          </div>
          <EventList events={events} />
        </section>

        <section style={{ padding: "20px", overflowY: "auto" }}>
          <SummaryDrawer />
        </section>
      </div>
    </SelectionProvider>
  );
}
