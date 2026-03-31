/**
 * ApiKeysPanel — list, create, and revoke API keys.
 *
 * • Table shows name, masked prefix, scopes, created date, last used, expiry.
 * • "Create key" opens a modal: name, scope checkboxes, expiry picker.
 * • After creation the full secret is shown once with a copy-to-clipboard button.
 * • Revoking requires an inline confirmation click.
 *
 * Admin-only: viewers see the table read-only with all action buttons hidden.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchApiKeys, createApiKey, revokeApiKey } from "../../api/settings";
import type { CreateApiKeyRequest, ApiKey } from "../../types";

// ── Constants ─────────────────────────────────────────────────────────────────

const AVAILABLE_SCOPES = [
  { id: "read:sites",      label: "Read sites" },
  { id: "write:sites",     label: "Write sites" },
  { id: "read:inventory",  label: "Read inventory" },
  { id: "write:inventory", label: "Write inventory" },
  { id: "read:moisture",   label: "Read moisture" },
  { id: "write:moisture",  label: "Write moisture" },
  { id: "read:alerts",     label: "Read alerts" },
  { id: "write:alerts",    label: "Write alerts" },
];

const EXPIRY_OPTIONS = [
  { label: "Never",    value: undefined },
  { label: "30 days",  value: 30  },
  { label: "90 days",  value: 90  },
  { label: "1 year",   value: 365 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function isExpired(iso: string | undefined): boolean {
  return !!iso && new Date(iso) < new Date();
}

function copyText(text: string) {
  void navigator.clipboard.writeText(text);
}

// ── Secret reveal modal ───────────────────────────────────────────────────────

function SecretModal({ secret, keyName, onClose }: {
  secret: string; keyName: string; onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    copyText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center">
            <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900">Save your API key</h2>
            <p className="text-xs text-slate-500">{keyName}</p>
          </div>
        </div>

        <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
          <p className="text-xs font-semibold text-amber-700 mb-2 uppercase tracking-wide">
            This key will only be shown once
          </p>
          <p className="text-xs text-amber-600 mb-3">
            Copy it now and store it securely. You won't be able to retrieve it again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-white border border-amber-200 rounded-lg px-3 py-2
                             font-mono text-slate-700 break-all select-all">
              {secret}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className={`shrink-0 px-3 py-2 text-xs font-semibold rounded-lg transition-colors
                ${copied
                  ? "bg-green-100 text-green-700"
                  : "bg-amber-100 text-amber-700 hover:bg-amber-200"
                }`}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full px-4 py-2.5 text-sm font-semibold bg-slate-800 hover:bg-slate-700
                     text-white rounded-lg transition-colors"
        >
          I've saved my key — close
        </button>
      </div>
    </div>
  );
}

// ── Create key modal ──────────────────────────────────────────────────────────

function CreateKeyModal({
  onClose,
  onCreate,
  isPending,
  isError,
}: {
  onClose:   () => void;
  onCreate:  (req: CreateApiKeyRequest) => void;
  isPending: boolean;
  isError:   boolean;
}) {
  const [name,      setName]      = useState("");
  const [scopes,    setScopes]    = useState<string[]>(["read:sites", "read:inventory", "read:moisture", "read:alerts"]);
  const [expiresIn, setExpiresIn] = useState<number | undefined>(90);

  const toggleScope = (id: string) =>
    setScopes((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);

  const valid = name.trim() && scopes.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
          <h2 className="text-base font-bold text-slate-900">Create API key</h2>
          <button type="button" onClick={onClose}
                  className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1 uppercase tracking-wide">
              Key name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production ingestion service"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Expiry */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1 uppercase tracking-wide">
              Expiry
            </label>
            <div className="flex gap-2">
              {EXPIRY_OPTIONS.map((opt) => (
                <button
                  key={String(opt.value)}
                  type="button"
                  onClick={() => setExpiresIn(opt.value)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors
                    ${expiresIn === opt.value
                      ? "bg-blue-600 text-white border-blue-600"
                      : "border-slate-300 text-slate-600 hover:bg-slate-50"
                    }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Scopes */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">
              Permissions
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {AVAILABLE_SCOPES.map((scope) => {
                const checked = scopes.includes(scope.id);
                return (
                  <label
                    key={scope.id}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer
                                transition-colors text-sm select-none
                      ${checked
                        ? "border-blue-300 bg-blue-50 text-blue-800"
                        : "border-slate-200 text-slate-600 hover:bg-slate-50"
                      }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleScope(scope.id)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                    {scope.label}
                  </label>
                );
              })}
            </div>
          </div>

          {isError && (
            <p className="text-xs text-red-600">Failed to create key — please try again.</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose}
                  className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-200
                             rounded-lg transition-colors">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onCreate({ name: name.trim(), scopes, expiresIn })}
            disabled={!valid || isPending}
            className="px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white
                       rounded-lg shadow-sm disabled:opacity-50 transition-colors"
          >
            {isPending ? "Creating…" : "Create key"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Key row ───────────────────────────────────────────────────────────────────

function KeyRow({ apiKey, canEdit }: { apiKey: ApiKey; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const revokeMut = useMutation({
    mutationFn: () => revokeApiKey(apiKey.id),
    onSuccess:  () => { void queryClient.invalidateQueries({ queryKey: ["api-keys"] }); },
  });

  const expired = isExpired(apiKey.expiresAt);

  return (
    <tr className={`border-t border-slate-100 hover:bg-slate-50 transition-colors ${expired ? "opacity-60" : ""}`}>
      <td className="px-4 py-3.5">
        <p className="text-sm font-semibold text-slate-800">{apiKey.name}</p>
        {expired && <span className="text-xs text-red-500 font-medium">Expired</span>}
      </td>
      <td className="px-4 py-3.5">
        <code className="text-xs font-mono bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
          {apiKey.prefix}••••••••
        </code>
      </td>
      <td className="px-4 py-3.5">
        <div className="flex flex-wrap gap-1">
          {apiKey.scopes.map((s) => (
            <span key={s} className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
              {s}
            </span>
          ))}
        </div>
      </td>
      <td className="px-4 py-3.5 text-xs text-slate-500 whitespace-nowrap">{fmtDate(apiKey.createdAt)}</td>
      <td className="px-4 py-3.5 text-xs text-slate-500 whitespace-nowrap">{fmtDate(apiKey.lastUsedAt)}</td>
      <td className="px-4 py-3.5 text-xs text-slate-500 whitespace-nowrap">
        {apiKey.expiresAt ? (
          <span className={expired ? "text-red-500 font-medium" : ""}>{fmtDate(apiKey.expiresAt)}</span>
        ) : "Never"}
      </td>
      <td className="px-4 py-3.5">
        {canEdit && (
          confirming ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => revokeMut.mutate()}
                disabled={revokeMut.isPending}
                className="text-xs font-semibold text-red-600 hover:text-red-800 border border-red-300
                           hover:bg-red-50 px-2.5 py-1.5 rounded-lg transition-colors"
              >
                {revokeMut.isPending ? "…" : "Revoke"}
              </button>
              <button type="button" onClick={() => setConfirming(false)}
                      className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1.5 rounded">
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="text-xs font-medium text-slate-500 hover:text-red-600 border border-slate-200
                         hover:border-red-300 px-3 py-1.5 rounded-lg transition-colors"
            >
              Revoke
            </button>
          )
        )}
      </td>
    </tr>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function ApiKeysPanel({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newSecret,  setNewSecret]  = useState<{ secret: string; name: string } | null>(null);

  const keysQuery = useQuery({ queryKey: ["api-keys"], queryFn: fetchApiKeys });
  const keys = keysQuery.data ?? [];

  const createMut = useMutation({
    mutationFn: createApiKey,
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      setShowCreate(false);
      setNewSecret({ secret: res.secret, name: res.key.name });
    },
  });

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            {keys.length} key{keys.length !== 1 ? "s" : ""} · Keys authenticate machine-to-machine calls to the REST API.
          </p>
          {canEdit && (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-800
                         px-3 py-1.5 rounded-lg hover:bg-blue-50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Create key
            </button>
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          {keysQuery.isLoading ? (
            <p className="text-sm text-slate-400 text-center py-10">Loading…</p>
          ) : keys.length === 0 ? (
            <div className="py-12 text-center">
              <svg className="mx-auto w-8 h-8 text-slate-200 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
              <p className="text-sm text-slate-400">No API keys yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    {["Name", "Key", "Scopes", "Created", "Last used", "Expires", ""].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <KeyRow key={key.id} apiKey={key} canEdit={canEdit} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {showCreate && (
        <CreateKeyModal
          onClose={() => setShowCreate(false)}
          onCreate={(req) => createMut.mutate(req)}
          isPending={createMut.isPending}
          isError={createMut.isError}
        />
      )}

      {newSecret && (
        <SecretModal
          secret={newSecret.secret}
          keyName={newSecret.name}
          onClose={() => setNewSecret(null)}
        />
      )}
    </>
  );
}
