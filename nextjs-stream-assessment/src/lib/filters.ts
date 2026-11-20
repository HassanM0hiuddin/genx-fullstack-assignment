import type { Severity, SystemEvent } from "./mockData";

export type SeverityFilter = Severity | "all";

export interface EventFilters {
  search: string;
  severity: SeverityFilter;
}

const SEVERITY_VALUES: readonly SeverityFilter[] = ["all", "info", "warning", "critical"];

function first(value: string | string[] | null | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}

/** Normalises raw query params (from a Server Component or a Route Handler) into typed filters. */
export function parseFilters(params: {
  search?: string | string[] | null;
  severity?: string | string[] | null;
}): EventFilters {
  const search = (first(params.search) ?? "").trim();
  const rawSeverity = first(params.severity) ?? "all";
  const severity = (SEVERITY_VALUES as readonly string[]).includes(rawSeverity)
    ? (rawSeverity as SeverityFilter)
    : "all";
  return { search, severity };
}

/** Builds the canonical query string. Default values are omitted to keep URLs clean. */
export function filtersToQuery({ search, severity }: EventFilters): string {
  const params = new URLSearchParams();
  const trimmed = search.trim();
  if (trimmed) params.set("search", trimmed);
  if (severity !== "all") params.set("severity", severity);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function filterEvents(events: SystemEvent[], { search, severity }: EventFilters): SystemEvent[] {
  const needle = search.toLowerCase().trim();
  return events.filter((evt) => {
    const matchesSeverity = severity === "all" || evt.severity === severity;
    const matchesSearch =
      !needle ||
      evt.title.toLowerCase().includes(needle) ||
      evt.service.toLowerCase().includes(needle) ||
      evt.id.toLowerCase().includes(needle);
    return matchesSeverity && matchesSearch;
  });
}
