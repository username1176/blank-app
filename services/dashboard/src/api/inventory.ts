import { apiClient }                               from "./client";
import type { InventoryItem, InventoryFilters, PaginatedResponse } from "../types";

export async function fetchInventory(
  filters: InventoryFilters = {},
): Promise<PaginatedResponse<InventoryItem>> {
  const { data } = await apiClient.get<PaginatedResponse<InventoryItem>>(
    "/api/inventory/items",
    { params: filters },
  );
  return data;
}

export async function fetchInventoryBySite(siteId: string): Promise<InventoryItem[]> {
  const { data } = await apiClient.get<InventoryItem[]>(
    `/api/inventory/items`,
    { params: { siteId, limit: 100 } },
  );
  return data;
}
