/**
 * NotificationSettingsPanel — inline notification configuration.
 *
 * Sections:
 *   1. Channels — email toggle + address chips, SMS toggle + phone number chips
 *   2. Alert Thresholds — warning/critical inputs per metric, add/remove rows
 *
 * Fetches and saves via /api/alerts/settings/:customerId.
 */

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore }          from "../../store/authStore";
import { fetchAlertSettings, updateAlertSettings } from "../../api/alerts";
import { PageLoader }            from "../ui/LoadingSpinner";
import type { AlertSettings, AlertThreshold } from "../../types";

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: AlertSettings = {
  preferences: {
    emailEnabled:   true,
    smsEnabled:     false,
    emailAddresses: [],
    phoneNumbers:   [],
  },
  thresholds: [
    { metricType: "moisture_percent",   warningValue: 20, criticalValue: 30, unit: "%" },
    { metricType: "temperature_celsius", warningValue: 60, criticalValue: 80, unit: "°C" },
  ],
};

// ── Subcomponents ─────────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold text-slate-800 mb-4 flex items-center gap-2">
      {children}
    </h3>
  );
}

function Toggle({
  enabled,
  onChange,
  label,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-3 cursor-pointer select-none">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onChange(!enabled)}
        className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none
                    focus:ring-2 focus:ring-blue-500 focus:ring-offset-1
                    ${enabled ? "bg-blue-600" : "bg-slate-200"}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow
                      transition-transform ${enabled ? "translate-x-5" : "translate-x-0"}`}
        />
      </button>
      <span className="text-sm text-slate-700">{label}</span>
    </label>
  );
}

function ContactChips({
  items,
  onRemove,
  colorClass = "bg-blue-50 text-blue-700 ring-blue-600/20",
}: {
  items:      string[];
  onRemove:   (item: string) => void;
  colorClass?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {items.map((item) => (
        <span
          key={item}
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium
                      ring-1 ring-inset ${colorClass}`}
        >
          {item}
          <button
            type="button"
            onClick={() => onRemove(item)}
            aria-label={`Remove ${item}`}
            className="opacity-60 hover:opacity-100 transition-opacity"
          >
            <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
              <path d="M2.293 2.293a1 1 0 011.414 0L6 4.586l2.293-2.293a1 1 0 111.414 1.414L7.414 6l2.293 2.293a1 1 0 01-1.414 1.414L6 7.414l-2.293 2.293a1 1 0 01-1.414-1.414L4.586 6 2.293 3.707a1 1 0 010-1.414z" />
            </svg>
          </button>
        </span>
      ))}
    </div>
  );
}

// ── Empty threshold row form ───────────────────────────────────────────────────

interface NewThresholdDraft {
  metricType:    string;
  unit:          string;
  warningValue:  string;
  criticalValue: string;
}

const EMPTY_DRAFT: NewThresholdDraft = {
  metricType: "", unit: "", warningValue: "", criticalValue: "",
};

// ── Main component ────────────────────────────────────────────────────────────

export default function NotificationSettingsPanel() {
  const customerId  = useAuthStore((s) => s.user?.customerId ?? "");
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ["alertSettings", customerId],
    queryFn:  () => fetchAlertSettings(customerId),
    enabled:  !!customerId,
  });

  const [form, setForm] = useState<AlertSettings>(DEFAULT_SETTINGS);

  // Track unsaved changes
  const [dirty,       setDirty]       = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Input states
  const [emailInput, setEmailInput] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [newDraft,   setNewDraft]   = useState<NewThresholdDraft | null>(null);

  // Populate form from API data
  useEffect(() => {
    if (settingsQuery.data) {
      setForm(settingsQuery.data);
      setDirty(false);
    }
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => updateAlertSettings(customerId, form),
    onSuccess: (updated) => {
      queryClient.setQueryData(["alertSettings", customerId], updated);
      setDirty(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    },
  });

  // ── Form helpers ─────────────────────────────────────────────────────────────

  function updatePref<K extends keyof typeof form.preferences>(
    key: K,
    value: typeof form.preferences[K],
  ) {
    setForm((f) => ({ ...f, preferences: { ...f.preferences, [key]: value } }));
    setDirty(true);
  }

  function addEmail() {
    const e = emailInput.trim().toLowerCase();
    if (!e || form.preferences.emailAddresses.includes(e)) return;
    updatePref("emailAddresses", [...form.preferences.emailAddresses, e]);
    setEmailInput("");
  }

  function removeEmail(email: string) {
    updatePref("emailAddresses", form.preferences.emailAddresses.filter((x) => x !== email));
  }

  function addPhone() {
    const p = phoneInput.trim();
    if (!p || form.preferences.phoneNumbers.includes(p)) return;
    updatePref("phoneNumbers", [...form.preferences.phoneNumbers, p]);
    setPhoneInput("");
  }

  function removePhone(phone: string) {
    updatePref("phoneNumbers", form.preferences.phoneNumbers.filter((x) => x !== phone));
  }

  function updateThreshold(idx: number, field: keyof AlertThreshold, value: string | number) {
    setForm((f) => {
      const thresholds = f.thresholds.map((t, i) =>
        i === idx ? { ...t, [field]: value } : t,
      );
      return { ...f, thresholds };
    });
    setDirty(true);
  }

  function removeThreshold(idx: number) {
    setForm((f) => ({ ...f, thresholds: f.thresholds.filter((_, i) => i !== idx) }));
    setDirty(true);
  }

  function commitNewThreshold() {
    if (!newDraft) return;
    const { metricType, unit, warningValue, criticalValue } = newDraft;
    if (!metricType || !unit || !warningValue || !criticalValue) return;
    const t: AlertThreshold = {
      metricType,
      unit,
      warningValue:  Number(warningValue),
      criticalValue: Number(criticalValue),
    };
    setForm((f) => ({ ...f, thresholds: [...f.thresholds, t] }));
    setNewDraft(null);
    setDirty(true);
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (settingsQuery.isLoading) return <PageLoader />;

  return (
    <div className="space-y-6">

      {/* ── Section 1: Notification channels ─────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <SectionHeading>
          <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
          Notification Channels
        </SectionHeading>

        <div className="space-y-6">
          {/* Email */}
          <div className="space-y-3">
            <Toggle
              enabled={form.preferences.emailEnabled}
              onChange={(v) => updatePref("emailEnabled", v)}
              label="Email notifications"
            />

            {form.preferences.emailEnabled && (
              <div className="ml-13 pl-1">
                <label className="block text-xs font-medium text-slate-600 mb-1.5">
                  Email addresses
                </label>
                <div className="flex gap-2">
                  <input
                    type="email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addEmail())}
                    placeholder="ops@example.com"
                    className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm
                               focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={addEmail}
                    className="px-3 py-2 text-sm font-medium bg-slate-100 hover:bg-slate-200
                               rounded-lg text-slate-700 transition-colors"
                  >
                    Add
                  </button>
                </div>
                <ContactChips
                  items={form.preferences.emailAddresses}
                  onRemove={removeEmail}
                  colorClass="bg-blue-50 text-blue-700 ring-blue-600/20"
                />
                {form.preferences.emailAddresses.length === 0 && (
                  <p className="text-xs text-slate-400 mt-2">No email addresses yet.</p>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-slate-100" />

          {/* SMS */}
          <div className="space-y-3">
            <Toggle
              enabled={form.preferences.smsEnabled}
              onChange={(v) => updatePref("smsEnabled", v)}
              label="SMS notifications"
            />

            {form.preferences.smsEnabled && (
              <div className="ml-13 pl-1">
                <label className="block text-xs font-medium text-slate-600 mb-1.5">
                  Phone numbers <span className="text-slate-400 font-normal">(E.164 format, e.g. +12025551234)</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="tel"
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addPhone())}
                    placeholder="+12025551234"
                    className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm
                               focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={addPhone}
                    className="px-3 py-2 text-sm font-medium bg-slate-100 hover:bg-slate-200
                               rounded-lg text-slate-700 transition-colors"
                  >
                    Add
                  </button>
                </div>
                <ContactChips
                  items={form.preferences.phoneNumbers}
                  onRemove={removePhone}
                  colorClass="bg-green-50 text-green-700 ring-green-600/20"
                />
                {form.preferences.phoneNumbers.length === 0 && (
                  <p className="text-xs text-slate-400 mt-2">No phone numbers yet.</p>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── Section 2: Alert thresholds ───────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <SectionHeading>
          <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          Alert Thresholds
        </SectionHeading>

        {/* Table header */}
        <div className="grid grid-cols-[1fr_100px_100px_100px_32px] gap-x-3 mb-2 px-1">
          {["Metric", "Unit", "Warning ⚠", "Critical ✕", ""].map((h) => (
            <p key={h} className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{h}</p>
          ))}
        </div>

        <div className="space-y-2">
          {form.thresholds.map((t, i) => (
            <div
              key={`${t.metricType}-${i}`}
              className="grid grid-cols-[1fr_100px_100px_100px_32px] gap-x-3 items-center
                         rounded-lg px-1 py-1 hover:bg-slate-50 group"
            >
              <p className="text-sm text-slate-700 truncate capitalize">
                {t.metricType.replace(/_/g, " ")}
              </p>
              <p className="text-sm text-slate-500 text-center">{t.unit}</p>
              <input
                type="number"
                value={t.warningValue}
                onChange={(e) => updateThreshold(i, "warningValue", Number(e.target.value))}
                className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-sm
                           text-amber-800 text-center focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <input
                type="number"
                value={t.criticalValue}
                onChange={(e) => updateThreshold(i, "criticalValue", Number(e.target.value))}
                className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-sm
                           text-red-800 text-center focus:outline-none focus:ring-2 focus:ring-red-400"
              />
              <button
                type="button"
                onClick={() => removeThreshold(i)}
                aria-label={`Remove ${t.metricType}`}
                className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100
                           transition-all rounded"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          ))}

          {/* New threshold form row */}
          {newDraft !== null ? (
            <div className="grid grid-cols-[1fr_100px_100px_100px_32px] gap-x-3 items-center
                            border border-blue-200 rounded-lg bg-blue-50/50 px-1 py-2">
              <input
                type="text"
                value={newDraft.metricType}
                onChange={(e) => setNewDraft({ ...newDraft, metricType: e.target.value })}
                placeholder="metric_name"
                autoFocus
                className="rounded-md border border-slate-300 px-2 py-1 text-sm
                           focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type="text"
                value={newDraft.unit}
                onChange={(e) => setNewDraft({ ...newDraft, unit: e.target.value })}
                placeholder="unit"
                className="rounded-md border border-slate-300 px-2 py-1 text-sm text-center
                           focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type="number"
                value={newDraft.warningValue}
                onChange={(e) => setNewDraft({ ...newDraft, warningValue: e.target.value })}
                placeholder="0"
                className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-sm
                           text-amber-800 text-center focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <input
                type="number"
                value={newDraft.criticalValue}
                onChange={(e) => setNewDraft({ ...newDraft, criticalValue: e.target.value })}
                placeholder="0"
                className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-sm
                           text-red-800 text-center focus:outline-none focus:ring-2 focus:ring-red-400"
              />
              <button
                type="button"
                onClick={() => setNewDraft(null)}
                className="text-slate-400 hover:text-slate-600"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              <div className="col-span-5 flex justify-end gap-2 mt-2 px-1">
                <button
                  type="button"
                  onClick={() => setNewDraft(null)}
                  className="text-xs text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg
                             hover:bg-slate-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={commitNewThreshold}
                  disabled={!newDraft.metricType || !newDraft.unit || !newDraft.warningValue || !newDraft.criticalValue}
                  className="text-xs font-semibold text-blue-700 bg-blue-100 hover:bg-blue-200
                             px-3 py-1.5 rounded-lg disabled:opacity-40 transition-colors"
                >
                  Add threshold
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setNewDraft(EMPTY_DRAFT)}
              className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800
                         mt-1 px-1 py-1 rounded transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Add metric threshold
            </button>
          )}
        </div>
      </section>

      {/* ── Save bar ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || !dirty}
          className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold
                     rounded-lg shadow-sm disabled:opacity-50 disabled:cursor-not-allowed
                     transition-colors"
        >
          {saveMutation.isPending ? "Saving…" : "Save settings"}
        </button>

        {!dirty && !saveSuccess && (
          <span className="text-xs text-slate-400">No unsaved changes</span>
        )}
        {dirty && (
          <span className="text-xs text-amber-600 font-medium">Unsaved changes</span>
        )}
        {saveSuccess && (
          <span className="text-xs text-green-600 font-semibold flex items-center gap-1">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Settings saved
          </span>
        )}
        {saveMutation.isError && (
          <span className="text-xs text-red-600 font-medium">Save failed — please try again.</span>
        )}
      </div>
    </div>
  );
}
