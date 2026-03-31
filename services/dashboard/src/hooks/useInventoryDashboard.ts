/**
 * useInventoryDashboard — data layer for the inventory dashboard page.
 *
 * Three parallel queries (all auto-refresh every 60 s):
 *   • sites           — list of all sites for this customer
 *   • inventoryItems  — all inventory items (up to 500 rows)
 *   • openAlerts      — all open alerts (for anomaly highlighting)
 *
 * One dependent query:
 *   • inventoryHistory — 30-day snapshots, scoped to selectedSiteId when set
 *
 * Derived state is memoised so components can destructure directly.
 */

import { useMemo }                  from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSites }               from "../api/sites";
import { fetchInventory, fetchInventoryHistory } from "../api/inventory";
import { fetchAlerts }              from "../api/alerts";
import type { AlertSeverity }       from "../types";

const REFETCH_INTERVAL = 60_000; // 60 s

export function useInventoryDashboard(selectedSiteId: string | null) {
  const queryClient = useQueryClient();

  // ── Base queries ─────────────────────────────────────────────────────────────

  const sitesQuery = useQuery({
    queryKey:       ["sites"],
    queryFn:        fetchSites,
    refetchInterval: REFETCH_INTERVAL,
  });

  const itemsQuery = useQuery({
    queryKey:       ["inventory-all"],
    queryFn:        () => fetchInventory({ limit: 500 }),
    refetchInterval: REFETCH_INTERVAL,
  });

  const alertsQuery = useQuery({
    queryKey:       ["alerts-open"],
    queryFn:        () => fetchAlerts({ status: "open", limit: 500 }),
    refetchInterval: REFETCH_INTERVAL,
  });

  // ── History query (depends on selectedSiteId) ─────────────────────────────────

  const historyQuery = useQuery({
    queryKey:       ["inventory-history", selectedSiteId],
    queryFn:        () => fetchInventoryHistory({ siteId: selectedSiteId ?? undefined, days: 30 }),
    refetchInterval: REFETCH_INTERVAL,
    placeholderData: (prev) => prev,
  });

  // ── Derived data ──────────────────────────────────────────────────────────────

  const sites       = sitesQuery.data  ?? [];
  const allItems    = itemsQuery.data?.data ?? [];
  const openAlerts  = alertsQuery.data?.data ?? [];

  const { totalVolume, totalPiles, itemsBySite, alertsBySite, anomalySiteIds } =
    useMemo(() => {
      let totalVolume = 0;
      let totalPiles  = 0;

      const itemsBySite  = new Map<string, typeof allItems>();
      const alertsBySite = new Map<string, typeof openAlerts>();

      for (const item of allItems) {
        totalVolume += item.estimatedVolumeCubicM;
        totalPiles  += item.pileCount;
        const existing = itemsBySite.get(item.siteId) ?? [];
        existing.push(item);
        itemsBySite.set(item.siteId, existing);
      }

      for (const alert of openAlerts) {
        const existing = alertsBySite.get(alert.siteId) ?? [];
        existing.push(alert);
        alertsBySite.set(alert.siteId, existing);
      }

      // Sites with at least one critical or warning open alert.
      const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 2, warning: 1, info: 0 };
      const anomalySiteIds = new Set(
        openAlerts
          .filter((a) => SEVERITY_RANK[a.severity] >= 1)
          .map((a) => a.siteId),
      );

      return { totalVolume, totalPiles, itemsBySite, alertsBySite, anomalySiteIds };
    }, [allItems, openAlerts]);

  // ── Manual refresh ────────────────────────────────────────────────────────────

  function refreshAll(): void {
    void queryClient.invalidateQueries({ queryKey: ["sites"] });
    void queryClient.invalidateQueries({ queryKey: ["inventory-all"] });
    void queryClient.invalidateQueries({ queryKey: ["alerts-open"] });
    void queryClient.invalidateQueries({ queryKey: ["inventory-history"] });
  }

  // ── Timestamp of oldest data fetch ────────────────────────────────────────────

  const dataUpdatedAt = Math.min(
    itemsQuery.dataUpdatedAt  || Infinity,
    alertsQuery.dataUpdatedAt || Infinity,
    sitesQuery.dataUpdatedAt  || Infinity,
  );

  return {
    sites,
    allItems,
    openAlerts,
    historySnapshots: historyQuery.data ?? [],

    totalVolume,
    totalPiles,
    itemsBySite,
    alertsBySite,
    anomalySiteIds,

    isLoading: sitesQuery.isLoading || itemsQuery.isLoading,
    isError:   sitesQuery.isError   || itemsQuery.isError,

    dataUpdatedAt: dataUpdatedAt === Infinity ? null : dataUpdatedAt,
    refreshAll,
  };
}
