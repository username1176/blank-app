import { useEffect, useState } from "react";
import { useQuery }             from "@tanstack/react-query";
import { useUiStore }           from "../store/uiStore";
import { fetchSites }           from "../api/sites";
import SiteMap                  from "../components/maps/SiteMap";
import { SiteStatusBadge }      from "../components/ui/Badge";
import { PageLoader }           from "../components/ui/LoadingSpinner";
import type { SiteStatus }      from "../types";

const STATUS_FILTERS: Array<{ label: string; value: SiteStatus | "all" }> = [
  { label: "All",      value: "all"      },
  { label: "Active",   value: "active"   },
  { label: "Warning",  value: "warning"  },
  { label: "Inactive", value: "inactive" },
];

export default function Sites() {
  const setPageTitle = useUiStore((s) => s.setPageTitle);
  useEffect(() => { setPageTitle("Sites"); }, [setPageTitle]);

  const [statusFilter, setStatusFilter] = useState<SiteStatus | "all">("all");
  const [search,       setSearch]       = useState("");

  const { data: sites = [], isLoading, isError } = useQuery({
    queryKey: ["sites"],
    queryFn:  fetchSites,
  });

  const filtered = sites.filter((site) => {
    const matchesStatus = statusFilter === "all" || site.status === statusFilter;
    const matchesSearch = site.name.toLowerCase().includes(search.toLowerCase()) ||
      (site.location.address ?? "").toLowerCase().includes(search.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          type="search"
          placeholder="Search sites…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm w-full sm:w-64
                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors
                ${statusFilter === f.value
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
                }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Map overview */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <SiteMap sites={filtered} className="w-full h-56" />
      </div>

      {/* Cards grid */}
      {isLoading && <PageLoader />}
      {isError && (
        <p className="text-sm text-red-600 text-center py-8">Failed to load sites.</p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map((site) => (
          <div
            key={site.id}
            className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 hover:shadow-md transition-shadow"
          >
            <div className="flex items-start justify-between gap-2 mb-3">
              <h3 className="font-semibold text-slate-800 leading-tight">{site.name}</h3>
              <SiteStatusBadge status={site.status} />
            </div>
            {site.location.address && (
              <p className="text-xs text-slate-500 mb-3 flex items-center gap-1">
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {site.location.address}
              </p>
            )}
            <div className="text-xs text-slate-400">
              {site.location.lat.toFixed(4)}, {site.location.lng.toFixed(4)}
            </div>
            <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-400">
              Updated {new Date(site.updatedAt).toLocaleDateString()}
            </div>
          </div>
        ))}
        {!isLoading && filtered.length === 0 && (
          <p className="col-span-full text-sm text-slate-400 text-center py-10">
            No sites match your filters.
          </p>
        )}
      </div>
    </div>
  );
}
