import { apiClient }                                    from "./client";
import type {
  MoistureReading, MoistureTimeRange, PaginatedResponse,
  PileZone, MoisturePrediction,
} from "../types";

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

/** Fetch all pile zones defined for a site (rarely changes). */
export async function fetchPileZones(siteId: string): Promise<PileZone[]> {
  const { data } = await apiClient.get<PileZone[]>(
    `/api/moisture/zones`,
    { params: { siteId } },
  );
  return data;
}

/**
 * Fetch the latest moisture prediction for every pile zone at a site.
 * This endpoint is polled every 30 s for the heatmap.
 */
export async function fetchMoisturePredictions(
  siteId: string,
): Promise<MoisturePrediction[]> {
  const { data } = await apiClient.get<MoisturePrediction[]>(
    `/api/moisture/predictions`,
    { params: { siteId } },
  );
  return data;
}
