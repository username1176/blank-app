import { apiClient }              from "./client";
import type { Site, PaginatedResponse } from "../types";

export async function fetchSites(): Promise<Site[]> {
  const { data } = await apiClient.get<Site[]>("/api/inventory/sites");
  return data;
}

export async function fetchSite(siteId: string): Promise<Site> {
  const { data } = await apiClient.get<Site>(`/api/inventory/sites/${siteId}`);
  return data;
}

export type { PaginatedResponse };
