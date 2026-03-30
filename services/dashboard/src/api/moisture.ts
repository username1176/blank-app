import { apiClient }                                    from "./client";
import type { MoistureReading, MoistureTimeRange, PaginatedResponse } from "../types";

export async function fetchMoistureReadings(
  siteId:    string,
  timeRange: MoistureTimeRange = "24h",
  limit = 200,
): Promise<MoistureReading[]> {
  const { data } = await apiClient.get<PaginatedResponse<MoistureReading>>(
    `/api/moisture/readings`,
    { params: { siteId, timeRange, limit } },
  );
  return data.data;
}

export async function fetchLatestMoisturePerSite(): Promise<MoistureReading[]> {
  const { data } = await apiClient.get<MoistureReading[]>(
    `/api/moisture/readings/latest`,
  );
  return data;
}
