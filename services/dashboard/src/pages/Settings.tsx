/**
 * Settings — tabbed configuration hub.
 *
 * Tabs
 *   Sites & Cameras  — site list/edit + camera URL management
 *   Sensor Thresholds — warning/critical values per metric
 *   API Keys         — machine-to-machine key lifecycle (admin only)
 *   Users            — invite, role-change, suspend, remove (admin only)
 *
 * Role guard
 *   isAdmin  = user.role === "admin"  (absent role treated as viewer)
 *   canEdit  = isAdmin for admin-only panels; true for shared panels
 *   Non-admin users see a "read-only" notice on admin tabs and all
 *   destructive/create actions are rendered disabled or hidden.
 */

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useUiStore }          from "../store/uiStore";
import { useAuthStore }        from "../store/authStore";
import { fetchAlertSettings, updateAlertSettings } from "../api/alerts";
import SitesPanel              from "../components/settings/SitesPanel";
import ApiKeysPanel            from "../components/settings/ApiKeysPanel";
import UsersPanel              from "../components/settings/UsersPanel";
import { PageLoader }          from "../components/ui/LoadingSpinner";
import type { AlertSettings, AlertThreshold } from "../types";

// ── Tab definition ────────────────────────────────────────────────────────────

type TabId = "sites" | "thresholds" | "apikeys" | "users";

interface Tab {
  id:        TabId;
  label:     string;
  adminOnly: boolean;
  icon:      React.ReactNode;
}

function Icon({ path }: { path: string }) {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

const TABS: Tab[] = [
  {
    id: "sites", label: "Sites & Cameras", adminOnly: false,
    icon: <Icon path="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />,
  },
  {
    id: "thresholds", label: "Sensor Thresholds", adminOnly: false,
    icon: <Icon path="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />,
  },
  {
    id: "apikeys", label: "API Keys", adminOnly: true,
    icon: <Icon path="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />,
  },
  {
    id: "users", label: "Users", adminOnly: true,
    icon: <Icon path="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />,
  },
];

// ── Read-only notice ──────────────────────────────────────────────────────────

function ReadOnlyNotice() {
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-100 border border-slate-200 mb-5">
      <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
      </svg>
      <p className="text-xs text-slate-500">
        <span className="font-semibold text-slate-700">Read-only.</span>{" "}
        Admin role required to make changes here. Contact your administrator.
      </p>
    </div>
  );
}

// ── Thresholds panel ──────────────────────────────────────────────────────────
// Inline because it's small and reuses alert settings — no extra component needed.

const DEFAULT_THRESHOLDS: AlertThreshold[] = [
  { metricType: "moisture_percent",    warningValue: 20, criticalValue: 30, unit: "%" },
  { metricType: "temperature_celsius", warningValue: 60, criticalValue: 80, unit: "°C" },
  { metricType: "pile_height_m",       warningValue: 8,  criticalValue: 12, unit: "m"  },
];

interface NewThresholdDraft {
  metricType:    string;
  unit:          string;
  warningValue:  string;
  criticalValue: string;
}

function ThresholdsPanel({ canEdit }: { canEdit: boolean }) {
  const customerId  = useAuthStore((s) => s.user?.customerId ?? "");
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ["alertSettings", customerId],
    queryFn:  () => fetchAlertSettings(customerId),
    enabled:  !!customerId,
  });

  const [thresholds, setThresholds] = useState<AlertThreshold[]>(DEFAULT_THRESHOLDS);
  const [dirty,      setDirty]      = useState(false);
  const [success,    setSuccess]    = useState(false);
  const [draft,      setDraft]      = useState<NewThresholdDraft | null>(null);

  useEffect(() => {
    if (settingsQuery.data?.thresholds.length) {
      setThresholds(settingsQuery.data.thresholds);
      setDirty(false);
    }
  }, [settingsQuery.data]);

  const saveMut = useMutation({
    mutationFn: () => {
      // Merge updated thresholds back into the full AlertSettings shape
      const base: AlertSettings = settingsQuery.data ?? {
        preferences: { emailEnabled: false, smsEnabled: false, emailAddresses: [], phoneNumbers: [] },
        thresholds: [],
      };
      return updateAlertSettings(customerId, { ...base, thresholds });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["alertSettings", customerId], updated);
      setDirty(false);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    },
  });

  const updateRow = (idx: number, field: keyof AlertThreshold, value: string | number) => {
    setThresholds((ts) => ts.map((t, i) => i === idx ? { ...t, [field]: value } : t));
    setDirty(true);
  };

  const removeRow = (idx: number) => {
    setThresholds((ts) => ts.filter((_, i) => i !== idx));
    setDirty(true);
  };

  const commitDraft = () => {
    if (!draft) return;
    const { metricType, unit, warningValue, criticalValue } = draft;
    if (!metricType || !unit || !warningValue || !criticalValue) return;
    setThresholds((ts) => [
      ...ts,
      { metricType, unit, warningValue: Number(warningValue), criticalValue: Number(criticalValue) },
    ]);
    setDraft(null);
    setDirty(true);
  };

  if (settingsQuery.isLoading) return <PageLoader />;

  const inputCls = (focus: string) =>
    `w-full rounded-md border px-2 py-1.5 text-sm text-center tabular-nums
     focus:outline-none focus:ring-2 ${focus}
     disabled:bg-slate-50 disabled:text-slate-400`;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Alerts fire when a sensor reading crosses a threshold. Warning fires first; critical fires at the higher value.
      </p>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Column headers */}
        <div className="grid grid-cols-[1fr_80px_110px_110px_36px] gap-x-2 px-4 py-3
                        bg-slate-50 border-b border-slate-200">
          {["Metric", "Unit", "Warning ⚠", "Critical ✕", ""].map((h) => (
            <p key={h} className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{h}</p>
          ))}
        </div>

        <div className="divide-y divide-slate-100">
          {thresholds.map((t, i) => (
            <div key={`${t.metricType}-${i}`}
                 className="grid grid-cols-[1fr_80px_110px_110px_36px] gap-x-2 px-4 py-3
                            items-center hover:bg-slate-50 group transition-colors">
              <p className="text-sm text-slate-800 capitalize">
                {t.metricType.replace(/_/g, " ")}
              </p>
              <p className="text-sm text-slate-500 text-center">{t.unit}</p>
              <input
                type="number"
                value={t.warningValue}
                disabled={!canEdit}
                onChange={(e) => updateRow(i, "warningValue", Number(e.target.value))}
                className={`${inputCls("focus:ring-amber-400")} border-amber-200 bg-amber-50 text-amber-800`}
              />
              <input
                type="number"
                value={t.criticalValue}
                disabled={!canEdit}
                onChange={(e) => updateRow(i, "criticalValue", Number(e.target.value))}
                className={`${inputCls("focus:ring-red-400")} border-red-200 bg-red-50 text-red-800`}
              />
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  className="p-1.5 rounded text-slate-300 hover:text-red-500 opacity-0
                             group-hover:opacity-100 transition-all"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round"
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              ) : <div />}
            </div>
          ))}

          {/* Draft row */}
          {draft !== null && (
            <div className="grid grid-cols-[1fr_80px_110px_110px_36px] gap-x-2 px-4 py-3
                            items-center bg-blue-50/60 border-t border-blue-200">
              <input
                type="text"
                autoFocus
                value={draft.metricType}
                onChange={(e) => setDraft({ ...draft, metricType: e.target.value })}
                placeholder="metric_name"
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm
                           focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type="text"
                value={draft.unit}
                onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
                placeholder="unit"
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-center
                           focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type="number"
                value={draft.warningValue}
                onChange={(e) => setDraft({ ...draft, warningValue: e.target.value })}
                placeholder="0"
                className={`${inputCls("focus:ring-amber-400")} border-amber-200 bg-amber-50 text-amber-800`}
              />
              <input
                type="number"
                value={draft.criticalValue}
                onChange={(e) => setDraft({ ...draft, criticalValue: e.target.value })}
                placeholder="0"
                className={`${inputCls("focus:ring-red-400")} border-red-200 bg-red-50 text-red-800`}
              />
              <button type="button" onClick={() => setDraft(null)}
                      className="p-1.5 rounded text-slate-400 hover:text-slate-600">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <div className="col-span-5 flex justify-end gap-2 pt-2 pr-1">
                <button type="button" onClick={() => setDraft(null)}
                        className="text-xs text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg hover:bg-slate-100">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={commitDraft}
                  disabled={!draft.metricType || !draft.unit || !draft.warningValue || !draft.criticalValue}
                  className="text-xs font-semibold text-blue-700 bg-blue-100 hover:bg-blue-200
                             px-3 py-1.5 rounded-lg disabled:opacity-40"
                >
                  Add threshold
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {canEdit && draft === null && (
        <button
          type="button"
          onClick={() => setDraft({ metricType: "", unit: "", warningValue: "", criticalValue: "" })}
          className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add metric threshold
        </button>
      )}

      {/* Save bar */}
      {canEdit && (
        <div className="flex items-center gap-4 pt-2">
          <button
            type="button"
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending || !dirty}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold
                       rounded-lg shadow-sm disabled:opacity-50 transition-colors"
          >
            {saveMut.isPending ? "Saving…" : "Save thresholds"}
          </button>
          {!dirty && !success && <span className="text-xs text-slate-400">No unsaved changes</span>}
          {dirty   && <span className="text-xs text-amber-600 font-medium">Unsaved changes</span>}
          {success && (
            <span className="text-xs text-green-600 font-semibold flex items-center gap-1">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Saved
            </span>
          )}
          {saveMut.isError && <span className="text-xs text-red-600">Save failed.</span>}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Settings() {
  const setPageTitle = useUiStore((s) => s.setPageTitle);
  useEffect(() => { setPageTitle("Settings"); }, [setPageTitle]);

  const user    = useAuthStore((s) => s.user);
  const isAdmin = user?.role === "admin";

  const [activeTab, setActiveTab] = useState<TabId>("sites");
  const tab = TABS.find((t) => t.id === activeTab)!;

  // Admin-only tabs: non-admins can view but not edit
  const canEdit = tab.adminOnly ? isAdmin : isAdmin;

  return (
    <div className="flex flex-col lg:flex-row gap-6 min-h-0">

      {/* ── Sidebar nav ──────────────────────────────────────────────────────── */}
      <nav className="lg:w-52 shrink-0">
        {/* Mobile: horizontal scroll */}
        <div className="lg:hidden flex gap-1 overflow-x-auto pb-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`shrink-0 flex items-center gap-1.5 px-3 py-2 text-sm font-medium
                          rounded-lg transition-colors whitespace-nowrap
                ${activeTab === t.id
                  ? "bg-white shadow-sm border border-slate-200 text-slate-800"
                  : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
                }`}
            >
              {t.icon}
              {t.label}
              {t.adminOnly && !isAdmin && (
                <svg className="w-3 h-3 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              )}
            </button>
          ))}
        </div>

        {/* Desktop: vertical list */}
        <ul className="hidden lg:flex flex-col gap-0.5">
          {TABS.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => setActiveTab(t.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm
                            font-medium transition-colors text-left
                  ${activeTab === t.id
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-slate-600 hover:text-slate-800 hover:bg-slate-100"
                  }`}
              >
                <span className="shrink-0">{t.icon}</span>
                <span className="flex-1">{t.label}</span>
                {t.adminOnly && !isAdmin && (
                  <svg className={`w-3.5 h-3.5 shrink-0 ${activeTab === t.id ? "text-blue-300" : "text-slate-300"}`}
                       fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round"
                      d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>

        {/* Role badge */}
        <div className="hidden lg:block mt-4 px-3">
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium
            ${isAdmin
              ? "bg-purple-50 text-purple-700 border border-purple-200"
              : "bg-slate-100 text-slate-500 border border-slate-200"
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            {isAdmin ? "Admin" : "Viewer"} role
          </div>
        </div>
      </nav>

      {/* ── Panel ────────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0">
        {/* Panel heading */}
        <div className="mb-5 flex items-center gap-2">
          <h2 className="text-base font-bold text-slate-800">{tab.label}</h2>
          {tab.adminOnly && !isAdmin && (
            <span className="text-xs font-medium bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full border border-slate-200">
              Read-only
            </span>
          )}
        </div>

        {/* Admin-only notice for viewers */}
        {tab.adminOnly && !isAdmin && <ReadOnlyNotice />}

        {/* Panel content */}
        {activeTab === "sites"      && <SitesPanel   canEdit={canEdit} />}
        {activeTab === "thresholds" && <ThresholdsPanel canEdit={canEdit} />}
        {activeTab === "apikeys"    && <ApiKeysPanel  canEdit={canEdit} />}
        {activeTab === "users"      && <UsersPanel    canEdit={canEdit} />}
      </div>

    </div>
  );
}
