import { apiClient } from "./client";
import type {
  Site, SiteUpsertRequest,
  Camera, CameraUpsertRequest,
  OrgUser, InviteUserRequest, UserRole,
  ApiKey, CreateApiKeyRequest, CreateApiKeyResponse,
} from "../types";

// ── Sites ──────────────────────────────────────────────────────────────────────

export async function updateSite(siteId: string, req: SiteUpsertRequest): Promise<Site> {
  const { data } = await apiClient.put<Site>(`/api/sites/${siteId}`, req);
  return data;
}

export async function createSite(req: SiteUpsertRequest): Promise<Site> {
  const { data } = await apiClient.post<Site>("/api/sites", req);
  return data;
}

export async function deleteSite(siteId: string): Promise<void> {
  await apiClient.delete(`/api/sites/${siteId}`);
}

// ── Cameras ────────────────────────────────────────────────────────────────────

export async function fetchCameras(siteId: string): Promise<Camera[]> {
  const { data } = await apiClient.get<Camera[]>(`/api/sites/${siteId}/cameras`);
  return data;
}

export async function createCamera(
  siteId: string,
  req:    CameraUpsertRequest,
): Promise<Camera> {
  const { data } = await apiClient.post<Camera>(`/api/sites/${siteId}/cameras`, req);
  return data;
}

export async function updateCamera(
  siteId:   string,
  cameraId: string,
  req:      CameraUpsertRequest,
): Promise<Camera> {
  const { data } = await apiClient.put<Camera>(`/api/sites/${siteId}/cameras/${cameraId}`, req);
  return data;
}

export async function deleteCamera(siteId: string, cameraId: string): Promise<void> {
  await apiClient.delete(`/api/sites/${siteId}/cameras/${cameraId}`);
}

// ── Users ──────────────────────────────────────────────────────────────────────

export async function fetchOrgUsers(): Promise<OrgUser[]> {
  const { data } = await apiClient.get<OrgUser[]>("/api/users");
  return data;
}

export async function inviteUser(req: InviteUserRequest): Promise<OrgUser> {
  const { data } = await apiClient.post<OrgUser>("/api/users/invite", req);
  return data;
}

export async function updateUserRole(userId: string, role: UserRole): Promise<OrgUser> {
  const { data } = await apiClient.put<OrgUser>(`/api/users/${userId}/role`, { role });
  return data;
}

export async function suspendUser(userId: string): Promise<OrgUser> {
  const { data } = await apiClient.put<OrgUser>(`/api/users/${userId}/suspend`);
  return data;
}

export async function unsuspendUser(userId: string): Promise<OrgUser> {
  const { data } = await apiClient.put<OrgUser>(`/api/users/${userId}/unsuspend`);
  return data;
}

export async function removeUser(userId: string): Promise<void> {
  await apiClient.delete(`/api/users/${userId}`);
}

// ── API keys ───────────────────────────────────────────────────────────────────

export async function fetchApiKeys(): Promise<ApiKey[]> {
  const { data } = await apiClient.get<ApiKey[]>("/api/api-keys");
  return data;
}

export async function createApiKey(req: CreateApiKeyRequest): Promise<CreateApiKeyResponse> {
  const { data } = await apiClient.post<CreateApiKeyResponse>("/api/api-keys", req);
  return data;
}

export async function revokeApiKey(keyId: string): Promise<void> {
  await apiClient.delete(`/api/api-keys/${keyId}`);
}
