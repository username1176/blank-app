/**
 * SitesPanel — site configuration and camera URL management.
 *
 * Each site row expands into an inline edit form (name, timezone, status,
 * lat/lng/address) and a camera sub-section where RTSP/HTTP/HLS feeds can be
 * added, edited, and deleted.
 *
 * Admin users can make changes; viewers see the data read-only.
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchSites }            from "../../api/sites";
import {
  updateSite, createSite, deleteSite,
  fetchCameras, createCamera, updateCamera, deleteCamera,
} from "../../api/settings";
import { SiteStatusBadge }       from "../ui/Badge";
import type {
  Site, SiteUpsertRequest, SiteStatus,
  CameraUpsertRequest, CameraType,
} from "../../types";

// ── Constants ─────────────────────────────────────────────────────────────────

const TIMEZONES = [
  "UTC", "America/New_York", "America/Chicago", "America/Denver",
  "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Europe/Paris",
  "Asia/Tokyo", "Asia/Shanghai", "Asia/Kolkata", "Australia/Sydney",
];

const CAMERA_TYPES: CameraType[] = ["rtsp", "http", "hls"];

const CAMERA_TYPE_LABELS: Record<CameraType, string> = {
  rtsp: "RTSP",
  http: "HTTP",
  hls:  "HLS",
};

const EMPTY_SITE: SiteUpsertRequest = {
  name: "", timezone: "UTC", status: "active",
  location: { lat: 0, lng: 0, address: "" },
};

const EMPTY_CAMERA: CameraUpsertRequest = {
  name: "", streamUrl: "", type: "rtsp", enabled: true, username: "", password: "",
};

// ── Shared UI ─────────────────────────────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium text-slate-500 mb-1 uppercase tracking-wide">
      {children}
    </label>
  );
}

function TextInput({
  value, onChange, placeholder, type = "text", disabled = false, className = "",
}: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  type?: string; disabled?: boolean; className?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded-lg border border-slate-300 px-3 py-2 text-sm
                 focus:outline-none focus:ring-2 focus:ring-blue-500
                 disabled:bg-slate-50 disabled:text-slate-400 ${className}`}
    />
  );
}

function Toggle({ enabled, onChange, disabled }: {
  enabled: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none
                  focus:ring-2 focus:ring-blue-500 focus:ring-offset-1
                  ${enabled ? "bg-blue-600" : "bg-slate-200"}
                  ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow
                        transition-transform ${enabled ? "translate-x-5" : ""}`} />
    </button>
  );
}

function SaveBar({
  onSave, onCancel, isPending, error,
}: {
  onSave: () => void; onCancel: () => void; isPending: boolean; error: boolean;
}) {
  return (
    <div className="flex items-center gap-3 pt-4 border-t border-slate-100 mt-4">
      <button
        type="button"
        onClick={onSave}
        disabled={isPending}
        className="px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white
                   rounded-lg shadow-sm disabled:opacity-50 transition-colors"
      >
        {isPending ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-100
                   rounded-lg transition-colors"
      >
        Cancel
      </button>
      {error && <span className="text-xs text-red-600">Save failed — please try again.</span>}
    </div>
  );
}

// ── Camera form ───────────────────────────────────────────────────────────────

function CameraForm({
  initial, onSave, onCancel, isPending, isError, canEdit,
}: {
  initial: CameraUpsertRequest;
  onSave:  (req: CameraUpsertRequest) => void;
  onCancel: () => void;
  isPending: boolean;
  isError:   boolean;
  canEdit:   boolean;
}) {
  const [form, setForm] = useState(initial);
  const set = <K extends keyof CameraUpsertRequest>(k: K, v: CameraUpsertRequest[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="border border-blue-200 bg-blue-50/40 rounded-xl p-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <FieldLabel>Camera name</FieldLabel>
          <TextInput value={form.name} onChange={(v) => set("name", v)}
                     placeholder="North entrance cam" disabled={!canEdit} />
        </div>
        <div>
          <FieldLabel>Type</FieldLabel>
          <select
            value={form.type}
            disabled={!canEdit}
            onChange={(e) => set("type", e.target.value as CameraType)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm
                       focus:outline-none focus:ring-2 focus:ring-blue-500
                       disabled:bg-slate-50 disabled:text-slate-400"
          >
            {CAMERA_TYPES.map((t) => (
              <option key={t} value={t}>{CAMERA_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <FieldLabel>Stream URL</FieldLabel>
        <TextInput
          value={form.streamUrl} onChange={(v) => set("streamUrl", v)}
          placeholder="rtsp://192.168.1.10:554/stream1" disabled={!canEdit}
        />
        <p className="text-xs text-slate-400 mt-1">
          RTSP: rtsp://… · HTTP MJPEG: http://… · HLS: http://…/playlist.m3u8
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <FieldLabel>Username (optional)</FieldLabel>
          <TextInput value={form.username ?? ""} onChange={(v) => set("username", v)}
                     placeholder="admin" disabled={!canEdit} />
        </div>
        <div>
          <FieldLabel>Password (leave blank to keep current)</FieldLabel>
          <TextInput value={form.password ?? ""} onChange={(v) => set("password", v)}
                     type="password" placeholder="••••••••" disabled={!canEdit} />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Toggle enabled={form.enabled} onChange={(v) => set("enabled", v)} disabled={!canEdit} />
        <span className="text-sm text-slate-600">Enabled</span>
      </div>

      {canEdit && (
        <SaveBar
          onSave={() => onSave(form)}
          onCancel={onCancel}
          isPending={isPending}
          error={isError}
        />
      )}
    </div>
  );
}

// ── Camera list for one site ───────────────────────────────────────────────────

function CamerasSection({ siteId, canEdit }: { siteId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["cameras", siteId],
    queryFn:  () => fetchCameras(siteId),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["cameras", siteId] });

  const createMut = useMutation({ mutationFn: (req: CameraUpsertRequest) => createCamera(siteId, req), onSuccess: () => { invalidate(); setAddingNew(false); } });
  const updateMut = useMutation({ mutationFn: ({ id, req }: { id: string; req: CameraUpsertRequest }) => updateCamera(siteId, id, req), onSuccess: () => { invalidate(); setEditingId(null); } });
  const deleteMut = useMutation({ mutationFn: (id: string) => deleteCamera(siteId, id), onSuccess: () => { invalidate(); setConfirmDelete(null); } });

  const cameras = query.data ?? [];

  return (
    <div className="mt-4 pt-4 border-t border-slate-100">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
          Cameras ({cameras.length})
        </p>
        {canEdit && !addingNew && (
          <button
            type="button"
            onClick={() => setAddingNew(true)}
            className="flex items-center gap-1 text-xs font-medium text-blue-600
                       hover:text-blue-800 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Add camera
          </button>
        )}
      </div>

      {query.isLoading && (
        <p className="text-xs text-slate-400">Loading cameras…</p>
      )}

      <div className="space-y-2">
        {cameras.map((cam) => (
          editingId === cam.id ? (
            <CameraForm
              key={cam.id}
              initial={{ name: cam.name, streamUrl: cam.streamUrl, type: cam.type,
                         enabled: cam.enabled, username: cam.username ?? "", password: "" }}
              onSave={(req) => updateMut.mutate({ id: cam.id, req })}
              onCancel={() => setEditingId(null)}
              isPending={updateMut.isPending}
              isError={updateMut.isError}
              canEdit={canEdit}
            />
          ) : (
            <div
              key={cam.id}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-slate-50
                         border border-slate-200 group"
            >
              {/* Camera icon */}
              <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9A2.25 2.25 0 0013.5 5.25h-9A2.25 2.25 0 002.25 9v9A2.25 2.25 0 004.5 18.75z" />
              </svg>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-800 truncate">{cam.name}</p>
                <p className="text-xs text-slate-400 font-mono truncate">{cam.streamUrl}</p>
              </div>

              <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ring-1 ring-inset
                ${cam.type === "rtsp" ? "bg-purple-50 text-purple-700 ring-purple-600/20"
                  : cam.type === "hls" ? "bg-blue-50 text-blue-700 ring-blue-600/20"
                  : "bg-slate-100 text-slate-600 ring-slate-500/20"}`}
              >
                {CAMERA_TYPE_LABELS[cam.type]}
              </span>

              <Toggle enabled={cam.enabled}
                      onChange={() => updateMut.mutate({ id: cam.id, req: { name: cam.name, streamUrl: cam.streamUrl, type: cam.type, enabled: !cam.enabled, username: cam.username } })}
                      disabled={!canEdit} />

              {canEdit && (
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button type="button" onClick={() => setEditingId(cam.id)}
                          className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </button>

                  {confirmDelete === cam.id ? (
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => deleteMut.mutate(cam.id)}
                              className="text-xs font-medium text-red-600 hover:text-red-800 px-2 py-1 rounded">
                        {deleteMut.isPending ? "…" : "Confirm"}
                      </button>
                      <button type="button" onClick={() => setConfirmDelete(null)}
                              className="text-xs text-slate-500 px-1 py-1 rounded hover:bg-slate-100">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setConfirmDelete(cam.id)}
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        ))}

        {cameras.length === 0 && !addingNew && (
          <p className="text-xs text-slate-400 italic">No cameras configured.</p>
        )}

        {addingNew && (
          <CameraForm
            initial={EMPTY_CAMERA}
            onSave={(req) => createMut.mutate(req)}
            onCancel={() => setAddingNew(false)}
            isPending={createMut.isPending}
            isError={createMut.isError}
            canEdit={canEdit}
          />
        )}
      </div>
    </div>
  );
}

// ── Site row ──────────────────────────────────────────────────────────────────

function SiteRow({ site, canEdit }: { site: Site; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [expanded,  setExpanded]  = useState(false);
  const [showDel,   setShowDel]   = useState(false);
  const [form, setForm] = useState<SiteUpsertRequest>({
    name:     site.name,
    timezone: site.timezone,
    status:   site.status,
    location: { ...site.location },
  });

  useEffect(() => {
    setForm({ name: site.name, timezone: site.timezone, status: site.status, location: { ...site.location } });
  }, [site]);

  const updateMut = useMutation({
    mutationFn: () => updateSite(site.id, form),
    onSuccess:  () => { void queryClient.invalidateQueries({ queryKey: ["sites"] }); setExpanded(false); },
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteSite(site.id),
    onSuccess:  () => void queryClient.invalidateQueries({ queryKey: ["sites"] }),
  });

  const setLoc = <K extends keyof typeof form.location>(k: K, v: typeof form.location[K]) =>
    setForm((f) => ({ ...f, location: { ...f.location, [k]: v } }));

  return (
    <div className={`rounded-xl border transition-colors ${expanded ? "border-blue-300 bg-blue-50/30" : "border-slate-200 bg-white"}`}>
      {/* Row header */}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left"
      >
        <svg className={`w-4 h-4 text-slate-400 transition-transform shrink-0 ${expanded ? "rotate-90" : ""}`}
             fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-800">{site.name}</p>
          <p className="text-xs text-slate-400 mt-0.5">{site.timezone} · {site.location.address ?? `${site.location.lat.toFixed(4)}, ${site.location.lng.toFixed(4)}`}</p>
        </div>
        <SiteStatusBadge status={site.status} />
      </button>

      {/* Expanded form */}
      {expanded && (
        <div className="px-5 pb-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <FieldLabel>Site name</FieldLabel>
              <TextInput value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))}
                         placeholder="Warehouse Alpha" disabled={!canEdit} />
            </div>
            <div>
              <FieldLabel>Status</FieldLabel>
              <select
                value={form.status}
                disabled={!canEdit}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as SiteStatus }))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-blue-500
                           disabled:bg-slate-50 disabled:text-slate-400"
              >
                <option value="active">Active</option>
                <option value="warning">Warning</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          </div>

          <div>
            <FieldLabel>Timezone</FieldLabel>
            <select
              value={form.timezone}
              disabled={!canEdit}
              onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-blue-500
                         disabled:bg-slate-50 disabled:text-slate-400"
            >
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <FieldLabel>Latitude</FieldLabel>
              <TextInput value={String(form.location.lat)}
                         onChange={(v) => setLoc("lat", parseFloat(v) || 0)}
                         type="number" placeholder="40.7128" disabled={!canEdit} />
            </div>
            <div>
              <FieldLabel>Longitude</FieldLabel>
              <TextInput value={String(form.location.lng)}
                         onChange={(v) => setLoc("lng", parseFloat(v) || 0)}
                         type="number" placeholder="-74.0060" disabled={!canEdit} />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <FieldLabel>Address (optional)</FieldLabel>
              <TextInput value={form.location.address ?? ""}
                         onChange={(v) => setLoc("address", v)}
                         placeholder="123 Warehouse Ave" disabled={!canEdit} />
            </div>
          </div>

          {/* Cameras sub-section */}
          <CamerasSection siteId={site.id} canEdit={canEdit} />

          {/* Save / delete */}
          {canEdit && (
            <div className="flex items-center justify-between pt-4 border-t border-slate-100">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => updateMut.mutate()}
                  disabled={updateMut.isPending}
                  className="px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white
                             rounded-lg shadow-sm disabled:opacity-50 transition-colors"
                >
                  {updateMut.isPending ? "Saving…" : "Save changes"}
                </button>
                <button type="button" onClick={() => setExpanded(false)}
                        className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                  Cancel
                </button>
                {updateMut.isError && (
                  <span className="text-xs text-red-600">Save failed.</span>
                )}
              </div>

              {showDel ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-red-600">Delete this site?</span>
                  <button type="button" onClick={() => deleteMut.mutate()}
                          disabled={deleteMut.isPending}
                          className="text-xs font-semibold text-red-600 hover:text-red-800 border border-red-300
                                     hover:bg-red-50 px-3 py-1.5 rounded-lg transition-colors">
                    {deleteMut.isPending ? "Deleting…" : "Yes, delete"}
                  </button>
                  <button type="button" onClick={() => setShowDel(false)}
                          className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1.5">
                    Cancel
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setShowDel(true)}
                        className="text-xs text-slate-400 hover:text-red-600 transition-colors">
                  Delete site
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── New site form ─────────────────────────────────────────────────────────────

function NewSiteForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<SiteUpsertRequest>(EMPTY_SITE);
  const setLoc = <K extends keyof typeof form.location>(k: K, v: typeof form.location[K]) =>
    setForm((f) => ({ ...f, location: { ...f.location, [k]: v } }));

  const mut = useMutation({
    mutationFn: () => createSite(form),
    onSuccess:  () => { void queryClient.invalidateQueries({ queryKey: ["sites"] }); onDone(); },
  });

  return (
    <div className="border-2 border-dashed border-blue-300 bg-blue-50/30 rounded-xl px-5 py-5 space-y-4">
      <p className="text-sm font-semibold text-slate-700">New site</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <FieldLabel>Site name *</FieldLabel>
          <TextInput value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} placeholder="Warehouse Beta" />
        </div>
        <div>
          <FieldLabel>Timezone</FieldLabel>
          <select value={form.timezone} onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Latitude</FieldLabel>
          <TextInput value={String(form.location.lat)} onChange={(v) => setLoc("lat", parseFloat(v) || 0)} type="number" placeholder="40.7128" />
        </div>
        <div>
          <FieldLabel>Longitude</FieldLabel>
          <TextInput value={String(form.location.lng)} onChange={(v) => setLoc("lng", parseFloat(v) || 0)} type="number" placeholder="-74.0060" />
        </div>
        <div className="sm:col-span-2">
          <FieldLabel>Address (optional)</FieldLabel>
          <TextInput value={form.location.address ?? ""} onChange={(v) => setLoc("address", v)} placeholder="123 Warehouse Ave, City, State" />
        </div>
      </div>

      <SaveBar onSave={() => mut.mutate()} onCancel={onDone} isPending={mut.isPending} error={mut.isError} />
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function SitesPanel({ canEdit }: { canEdit: boolean }) {
  const [addingNew, setAddingNew] = useState(false);

  const sitesQuery = useQuery({ queryKey: ["sites"], queryFn: fetchSites });
  const sites = sitesQuery.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm text-slate-500">{sites.length} site{sites.length !== 1 ? "s" : ""} configured</p>
        {canEdit && !addingNew && (
          <button
            type="button"
            onClick={() => setAddingNew(true)}
            className="flex items-center gap-1.5 text-sm font-medium text-blue-600
                       hover:text-blue-800 px-3 py-1.5 rounded-lg hover:bg-blue-50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Add site
          </button>
        )}
      </div>

      {sitesQuery.isLoading ? (
        <p className="text-sm text-slate-400 py-8 text-center">Loading sites…</p>
      ) : (
        <>
          {sites.map((site) => (
            <SiteRow key={site.id} site={site} canEdit={canEdit} />
          ))}
          {sites.length === 0 && !addingNew && (
            <p className="text-sm text-slate-400 py-8 text-center">No sites configured yet.</p>
          )}
        </>
      )}

      {addingNew && <NewSiteForm onDone={() => setAddingNew(false)} />}
    </div>
  );
}
