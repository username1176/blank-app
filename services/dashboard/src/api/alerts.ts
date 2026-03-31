import { apiClient }                                       from "./client";
import type { Alert, AlertFilters, AlertSettings, PaginatedResponse } from "../types";

export async function fetchAlerts(
  filters: AlertFilters = {},
): Promise<PaginatedResponse<Alert>> {
  const { data } = await apiClient.get<PaginatedResponse<Alert>>(
    "/api/alerts",
    { params: filters },
  );
  return data;
}

export async function acknowledgeAlert(alertId: string): Promise<Alert> {
  const { data } = await apiClient.put<Alert>(`/api/alerts/${alertId}/acknowledge`);
  return data;
}

export async function resolveAlert(alertId: string): Promise<Alert> {
  const { data } = await apiClient.put<Alert>(`/api/alerts/${alertId}/resolve`);
  return data;
}

export async function fetchAlertSettings(customerId: string): Promise<AlertSettings> {
  const { data } = await apiClient.get<AlertSettings>(
    `/api/alerts/settings/${customerId}`,
  );
  return data;
}

export async function updateAlertSettings(
  customerId: string,
  settings:   AlertSettings,
): Promise<AlertSettings> {
  const { data } = await apiClient.put<AlertSettings>(
    `/api/alerts/settings/${customerId}`,
    settings,
  );
  return data;
}
