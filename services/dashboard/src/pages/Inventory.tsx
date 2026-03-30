import { useEffect, useState } from "react";
import { useQuery }             from "@tanstack/react-query";
import { useUiStore }           from "../store/uiStore";
import { fetchInventory }       from "../api/inventory";
import { fetchSites }           from "../api/sites";
import { PageLoader }           from "../components/ui/LoadingSpinner";

const PAGE_SIZE = 20;

export default function Inventory() {
  const setPageTitle = useUiStore((s) => s.setPageTitle);
  useEffect(() => { setPageTitle("Inventory"); }, [setPageTitle]);

  const [page,         setPage]         = useState(1);
  const [siteFilter,   setSiteFilter]   = useState("");
  const [materialFilter, setMaterialFilter] = useState("");

  const sitesQuery = useQuery({ queryKey: ["sites"], queryFn: fetchSites });

  const inventoryQuery = useQuery({
    queryKey: ["inventory", { page, siteId: siteFilter, materialType: materialFilter }],
    queryFn:  () => fetchInventory({
      page,
      limit:        PAGE_SIZE,
      siteId:       siteFilter   || undefined,
      materialType: materialFilter || undefined,
    }),
    placeholderData: (prev) => prev,
  });

  const items      = inventoryQuery.data?.data      ?? [];
  const totalPages = inventoryQuery.data?.totalPages ?? 1;
  const total      = inventoryQuery.data?.total      ?? 0;

  const siteMap = Object.fromEntries(
    (sitesQuery.data ?? []).map((s) => [s.id, s.name]),
  );

  const handleFilterChange = () => setPage(1);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={siteFilter}
          onChange={(e) => { setSiteFilter(e.target.value); handleFilterChange(); }}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white
                     focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All sites</option>
          {(sitesQuery.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <input
          type="text"
          placeholder="Filter by material…"
          value={materialFilter}
          onChange={(e) => { setMaterialFilter(e.target.value); handleFilterChange(); }}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm w-48
                     focus:outline-none focus:ring-2 focus:ring-blue-500"
        />

        <span className="ml-auto text-sm text-slate-400 self-center">
          {total} item{total !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {inventoryQuery.isLoading ? (
          <PageLoader />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  {["Material", "Site", "Quantity", "Volume (m³)", "Piles", "Last Updated"].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-slate-800">{item.materialType}</td>
                    <td className="px-4 py-3 text-slate-600">{siteMap[item.siteId] ?? item.siteId}</td>
                    <td className="px-4 py-3 text-slate-600 tabular-nums">
                      {item.quantity.toLocaleString()} {item.unit}
                    </td>
                    <td className="px-4 py-3 text-slate-600 tabular-nums">
                      {item.estimatedVolumeCubicM.toFixed(1)}
                    </td>
                    <td className="px-4 py-3 text-slate-600 tabular-nums">{item.pileCount}</td>
                    <td className="px-4 py-3 text-slate-400">
                      {new Date(item.lastUpdatedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                      No inventory items found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="text-sm text-slate-600 hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            ← Previous
          </button>
          <span className="text-sm text-slate-500">Page {page} of {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="text-sm text-slate-600 hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
