/**
 * UsersPanel — user management with role-based access control.
 *
 * Table columns: avatar, name/email, role, status, last login, actions.
 *
 * Admin actions:
 *   • Invite new user (modal: email, name, role)
 *   • Change role inline (admin ↔ viewer dropdown)
 *   • Suspend / unsuspend
 *   • Remove user (with inline confirmation)
 *
 * Guards:
 *   • Current user's own row shows "You" badge; can't change own role or remove self.
 *   • Viewer-mode hides all action buttons.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../../store/authStore";
import {
  fetchOrgUsers, inviteUser, updateUserRole,
  suspendUser, unsuspendUser, removeUser,
} from "../../api/settings";
import type { OrgUser, UserRole, UserStatus, InviteUserRequest } from "../../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name.split(" ").map((w) => w[0] ?? "").slice(0, 2).join("").toUpperCase();
}

function avatarColor(email: string): string {
  const COLORS = [
    "bg-blue-500",   "bg-violet-500", "bg-emerald-500",
    "bg-orange-500", "bg-pink-500",   "bg-cyan-500",
    "bg-amber-500",  "bg-teal-500",
  ];
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30)  return `${days}d ago`;
  return d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

const STATUS_STYLES: Record<UserStatus, string> = {
  active:    "bg-green-50  text-green-700  ring-green-600/20",
  invited:   "bg-amber-50  text-amber-700  ring-amber-600/20",
  suspended: "bg-slate-100 text-slate-500  ring-slate-400/20",
};

// ── Invite modal ──────────────────────────────────────────────────────────────

function InviteModal({
  onClose, onInvite, isPending, isError,
}: {
  onClose:   () => void;
  onInvite:  (req: InviteUserRequest) => void;
  isPending: boolean;
  isError:   boolean;
}) {
  const [email, setEmail] = useState("");
  const [name,  setName]  = useState("");
  const [role,  setRole]  = useState<UserRole>("viewer");

  const valid = email.trim() && name.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
          <h2 className="text-base font-bold text-slate-900">Invite user</h2>
          <button type="button" onClick={onClose}
                  className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1 uppercase tracking-wide">
              Email address *
            </label>
            <input
              type="email"
              value={email}
              autoFocus
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@company.com"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1 uppercase tracking-wide">
              Full name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Smith"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Role */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">
              Role
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(["admin", "viewer"] as UserRole[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  className={`flex flex-col items-start px-4 py-3 rounded-xl border-2 transition-colors text-left
                    ${role === r ? "border-blue-500 bg-blue-50" : "border-slate-200 hover:border-slate-300"}`}
                >
                  <span className="text-sm font-semibold text-slate-800 capitalize">{r}</span>
                  <span className="text-xs text-slate-500 mt-0.5">
                    {r === "admin"
                      ? "Full access to all settings and data"
                      : "Read-only access to dashboards"}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {isError && (
            <p className="text-xs text-red-600">Invite failed — please try again.</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose}
                  className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-200 rounded-lg transition-colors">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onInvite({ email: email.trim(), name: name.trim(), role })}
            disabled={!valid || isPending}
            className="px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white
                       rounded-lg shadow-sm disabled:opacity-50 transition-colors"
          >
            {isPending ? "Sending invite…" : "Send invite"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── User row ──────────────────────────────────────────────────────────────────

function UserRow({
  user, isSelf, canEdit,
}: {
  user: OrgUser; isSelf: boolean; canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["org-users"] });

  const roleMut    = useMutation({ mutationFn: (role: UserRole) => updateUserRole(user.id, role), onSuccess: invalidate });
  const suspendMut = useMutation({ mutationFn: () => suspendUser(user.id),   onSuccess: invalidate });
  const resumeMut  = useMutation({ mutationFn: () => unsuspendUser(user.id), onSuccess: invalidate });
  const removeMut  = useMutation({ mutationFn: () => removeUser(user.id),    onSuccess: invalidate });

  const isSuspended = user.status === "suspended";
  const pending     = roleMut.isPending || suspendMut.isPending || resumeMut.isPending || removeMut.isPending;

  return (
    <tr className="border-t border-slate-100 hover:bg-slate-50 transition-colors group">
      {/* Avatar + name/email */}
      <td className="px-4 py-3.5">
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded-full ${avatarColor(user.email)} flex items-center
                          justify-center text-white text-xs font-bold shrink-0`}>
            {initials(user.name)}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-800 flex items-center gap-1.5 truncate">
              {user.name}
              {isSelf && (
                <span className="text-xs font-normal bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">
                  You
                </span>
              )}
            </p>
            <p className="text-xs text-slate-400 truncate">{user.email}</p>
          </div>
        </div>
      </td>

      {/* Role */}
      <td className="px-4 py-3.5">
        {canEdit && !isSelf ? (
          <select
            value={user.role}
            disabled={pending}
            onChange={(e) => roleMut.mutate(e.target.value as UserRole)}
            className={`rounded-lg border text-sm px-2 py-1.5 focus:outline-none
                        focus:ring-2 focus:ring-blue-500 transition-colors
                        ${user.role === "admin"
                          ? "border-purple-200 bg-purple-50 text-purple-800"
                          : "border-slate-200 bg-slate-50 text-slate-700"
                        } disabled:opacity-60`}
          >
            <option value="admin">Admin</option>
            <option value="viewer">Viewer</option>
          </select>
        ) : (
          <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium
                            ring-1 ring-inset
            ${user.role === "admin"
              ? "bg-purple-50 text-purple-700 ring-purple-600/20"
              : "bg-slate-100 text-slate-600 ring-slate-500/20"
            }`}>
            {user.role.charAt(0).toUpperCase() + user.role.slice(1)}
          </span>
        )}
      </td>

      {/* Status */}
      <td className="px-4 py-3.5">
        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium
                          ring-1 ring-inset ${STATUS_STYLES[user.status]}`}>
          {user.status.charAt(0).toUpperCase() + user.status.slice(1)}
        </span>
      </td>

      {/* Last login */}
      <td className="px-4 py-3.5 text-xs text-slate-500 whitespace-nowrap">
        {fmtDate(user.lastLoginAt)}
      </td>

      {/* Actions */}
      <td className="px-4 py-3.5">
        {canEdit && !isSelf && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {/* Suspend / Unsuspend */}
            <button
              type="button"
              disabled={pending || user.status === "invited"}
              onClick={() => isSuspended ? resumeMut.mutate() : suspendMut.mutate()}
              title={isSuspended ? "Unsuspend" : "Suspend"}
              className="p-1.5 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-50
                         disabled:opacity-40 transition-colors"
            >
              {isSuspended ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              )}
            </button>

            {/* Remove */}
            {confirmRemove ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => removeMut.mutate()}
                  disabled={removeMut.isPending}
                  className="text-xs font-semibold text-red-600 hover:text-red-800 border border-red-300
                             hover:bg-red-50 px-2.5 py-1.5 rounded-lg transition-colors"
                >
                  {removeMut.isPending ? "…" : "Remove"}
                </button>
                <button type="button" onClick={() => setConfirmRemove(false)}
                        className="text-xs text-slate-500 px-2 py-1.5 rounded hover:bg-slate-100">
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmRemove(true)}
                title="Remove user"
                className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function UsersPanel({ canEdit }: { canEdit: boolean }) {
  const currentUserId = useAuthStore((s) => s.user?.userId ?? "");
  const queryClient   = useQueryClient();
  const [showInvite, setShowInvite] = useState(false);

  const usersQuery = useQuery({ queryKey: ["org-users"], queryFn: fetchOrgUsers });
  const users      = usersQuery.data ?? [];

  const inviteMut = useMutation({
    mutationFn: inviteUser,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org-users"] });
      setShowInvite(false);
    },
  });

  const activeCount    = users.filter((u) => u.status === "active").length;
  const invitedCount   = users.filter((u) => u.status === "invited").length;
  const suspendedCount = users.filter((u) => u.status === "suspended").length;

  return (
    <>
      <div className="space-y-4">
        {/* Header row */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span><span className="font-semibold text-slate-700">{activeCount}</span> active</span>
            {invitedCount   > 0 && <span><span className="font-semibold text-amber-600">{invitedCount}</span> pending invite</span>}
            {suspendedCount > 0 && <span><span className="font-semibold text-slate-500">{suspendedCount}</span> suspended</span>}
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={() => setShowInvite(true)}
              className="flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-800
                         px-3 py-1.5 rounded-lg hover:bg-blue-50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
              </svg>
              Invite user
            </button>
          )}
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          {usersQuery.isLoading ? (
            <p className="text-sm text-slate-400 text-center py-10">Loading users…</p>
          ) : users.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-10">No users found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    {["User", "Role", "Status", "Last login", ""].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <UserRow
                      key={user.id}
                      user={user}
                      isSelf={user.id === currentUserId}
                      canEdit={canEdit}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* RBAC explainer */}
        <div className="rounded-xl bg-slate-50 border border-slate-200 p-4">
          <p className="text-xs font-semibold text-slate-600 mb-2">Role permissions</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              {
                role:  "Admin",
                color: "text-purple-700",
                perms: ["View all dashboards", "Acknowledge & resolve alerts", "Manage sites & cameras", "Manage sensor thresholds", "Manage API keys", "Invite & manage users"],
              },
              {
                role:  "Viewer",
                color: "text-slate-600",
                perms: ["View all dashboards", "Acknowledge alerts", "Read-only settings", "No site/key/user changes"],
              },
            ].map(({ role, color, perms }) => (
              <div key={role} className="space-y-1">
                <p className={`text-xs font-semibold ${color}`}>{role}</p>
                {perms.map((p) => (
                  <p key={p} className="text-xs text-slate-500 flex items-center gap-1.5">
                    <svg className="w-3 h-3 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    {p}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onInvite={(req) => inviteMut.mutate(req)}
          isPending={inviteMut.isPending}
          isError={inviteMut.isError}
        />
      )}
    </>
  );
}
