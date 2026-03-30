import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useUiStore }            from "../store/uiStore";
import { useAuthStore }          from "../store/authStore";
import { fetchAlertSettings, updateAlertSettings } from "../api/alerts";
import { PageLoader }            from "../components/ui/LoadingSpinner";
import type { AlertSettings, AlertThreshold } from "../types";

const DEFAULT_THRESHOLDS: AlertThreshold[] = [
  { metricType: "moisture_percent",  warningValue: 25, criticalValue: 15, unit: "%" },
  { metricType: "temperature_celsius", warningValue: 60, criticalValue: 80, unit: "°C" },
];

export default function Settings() {
  const setPageTitle = useUiStore((s) => s.setPageTitle);
  useEffect(() => { setPageTitle("Settings"); }, [setPageTitle]);

  const customerId  = useAuthStore((s) => s.user?.customerId ?? "");
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ["alertSettings", customerId],
    queryFn:  () => fetchAlertSettings(customerId),
    enabled:  !!customerId,
  });

  const [form, setForm] = useState<AlertSettings>({
    preferences: {
      emailEnabled:   true,
      smsEnabled:     false,
      emailAddresses: [],
      phoneNumbers:   [],
    },
    thresholds: DEFAULT_THRESHOLDS,
  });

  const [emailInput, setEmailInput] = useState("");
  const [saved,      setSaved]      = useState(false);

  // Populate form when data loads
  useEffect(() => {
    if (settingsQuery.data) setForm(settingsQuery.data);
  }, [settingsQuery.data]);

  const updateMutation = useMutation({
    mutationFn: () => updateAlertSettings(customerId, form),
    onSuccess: (updated) => {
      queryClient.setQueryData(["alertSettings", customerId], updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  const addEmail = () => {
    const e = emailInput.trim();
    if (e && !form.preferences.emailAddresses.includes(e)) {
      setForm((f) => ({
        ...f,
        preferences: { ...f.preferences, emailAddresses: [...f.preferences.emailAddresses, e] },
      }));
      setEmailInput("");
    }
  };

  const removeEmail = (email: string) =>
    setForm((f) => ({
      ...f,
      preferences: {
        ...f.preferences,
        emailAddresses: f.preferences.emailAddresses.filter((e) => e !== email),
      },
    }));

  const updateThreshold = (index: number, field: keyof AlertThreshold, value: string | number) =>
    setForm((f) => {
      const thresholds = [...f.thresholds];
      thresholds[index] = { ...thresholds[index]!, [field]: value };
      return { ...f, thresholds };
    });

  if (settingsQuery.isLoading) return <PageLoader />;

  return (
    <div className="max-w-2xl space-y-6">
      {/* Notification preferences */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <h2 className="text-base font-semibold text-slate-800 mb-4">Notification Preferences</h2>

        <div className="space-y-4">
          {/* Toggles */}
          <div className="flex flex-col gap-3">
            {(["emailEnabled", "smsEnabled"] as const).map((key) => (
              <label key={key} className="flex items-center gap-3 cursor-pointer">
                <div
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      preferences: { ...f.preferences, [key]: !f.preferences[key] },
                    }))
                  }
                  className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer
                    ${form.preferences[key] ? "bg-blue-600" : "bg-slate-200"}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform
                    ${form.preferences[key] ? "translate-x-5" : "translate-x-0"}`}
                  />
                </div>
                <span className="text-sm text-slate-700">
                  {key === "emailEnabled" ? "Email notifications" : "SMS notifications"}
                </span>
              </label>
            ))}
          </div>

          {/* Email addresses */}
          {form.preferences.emailEnabled && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Email addresses
              </label>
              <div className="flex gap-2 mb-2">
                <input
                  type="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addEmail())}
                  placeholder="add@example.com"
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm
                             focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={addEmail}
                  className="px-4 py-2 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg font-medium text-slate-700 transition-colors"
                >
                  Add
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {form.preferences.emailAddresses.map((email) => (
                  <span key={email} className="flex items-center gap-1 bg-blue-50 text-blue-700 text-xs rounded-full px-3 py-1">
                    {email}
                    <button onClick={() => removeEmail(email)} className="ml-1 hover:text-blue-900">×</button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Alert thresholds */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <h2 className="text-base font-semibold text-slate-800 mb-4">Alert Thresholds</h2>
        <div className="space-y-4">
          {form.thresholds.map((threshold, i) => (
            <div key={threshold.metricType} className="grid grid-cols-3 gap-3 items-end">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase tracking-wide">
                  Metric
                </label>
                <p className="text-sm text-slate-800 py-2">
                  {threshold.metricType.replace(/_/g, " ")}
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-amber-600 mb-1 uppercase tracking-wide">
                  Warning ({threshold.unit})
                </label>
                <input
                  type="number"
                  value={threshold.warningValue}
                  onChange={(e) => updateThreshold(i, "warningValue", Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm
                             focus:outline-none focus:ring-2 focus:ring-amber-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-red-600 mb-1 uppercase tracking-wide">
                  Critical ({threshold.unit})
                </label>
                <input
                  type="number"
                  value={threshold.criticalValue}
                  onChange={(e) => updateThreshold(i, "criticalValue", Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm
                             focus:outline-none focus:ring-2 focus:ring-red-400"
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Save */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => updateMutation.mutate()}
          disabled={updateMutation.isPending}
          className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold
                     rounded-lg shadow-sm disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {updateMutation.isPending ? "Saving…" : "Save settings"}
        </button>
        {saved && (
          <span className="text-sm text-green-600 font-medium">Settings saved ✓</span>
        )}
        {updateMutation.isError && (
          <span className="text-sm text-red-600">Failed to save — please try again.</span>
        )}
      </div>
    </div>
  );
}
