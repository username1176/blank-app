// ── Auth ───────────────────────────────────────────────────────────────────────

export interface LoginRequest {
  email:    string;
  password: string;
}

export interface TokenResponse {
  access_token:  string;
  refresh_token: string;
  token_type:    string;
  expires_in:    number;
}

// ── Tenant ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  userId:     string;
  customerId: string;
  email:      string | null;
  siteIds:    string[];
}

// ── Sites ──────────────────────────────────────────────────────────────────────

export type SiteStatus = "active" | "warning" | "inactive";

export interface SiteLocation {
  lat:      number;
  lng:      number;
  address?: string;
}

export interface Site {
  id:         string;
  customerId: string;
  name:       string;
  location:   SiteLocation;
  status:     SiteStatus;
  timezone:   string;
  createdAt:  string;
  updatedAt:  string;
}

// ── Inventory ──────────────────────────────────────────────────────────────────

export interface InventoryItem {
  id:                    string;
  siteId:                string;
  customerId:            string;
  materialType:          string;
  quantity:              number;
  unit:                  string;
  estimatedVolumeCubicM: number;
  pileCount:             number;
  lastUpdatedAt:         string;
}

export interface InventoryFilters {
  siteId?:       string;
  materialType?: string;
  page?:         number;
  limit?:        number;
}

// ── Moisture ───────────────────────────────────────────────────────────────────

export type MoistureSource = "sensor" | "edge_processor" | "ml_model";

export interface MoistureReading {
  id:                  string;
  siteId:              string;
  customerId:          string;
  moisturePercent:     number;
  temperatureCelsius:  number;
  source:              MoistureSource;
  timestamp:           string;
}

export type MoistureTimeRange = "24h" | "7d" | "30d";

export interface MoistureStats {
  min:  number;
  max:  number;
  avg:  number;
  last: number;
}

/**
 * A named pile zone in a warehouse floor plan.
 * row/col are 0-indexed grid coordinates; width/height default to 1.
 */
export interface PileZone {
  id:      string;
  siteId:  string;
  label:   string;   // e.g. "A1", "Bay 3"
  row:     number;
  col:     number;
  width?:  number;
  height?: number;
}

/**
 * Real-time (or predicted) moisture state for a single pile zone.
 * confidenceScore is 0–1; 1 = direct sensor reading, <1 = ML prediction.
 */
export interface MoisturePrediction {
  zoneId:          string;
  siteId:          string;
  moisturePercent: number;
  confidenceScore: number;
  predictedAt:     string;
  source:          MoistureSource;
}

// ── Alerts ─────────────────────────────────────────────────────────────────────

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertStatus   = "open" | "acknowledged" | "resolved";

export interface Alert {
  id:               string;
  customerId:       string;
  siteId:           string;
  severity:         AlertSeverity;
  status:           AlertStatus;
  type:             string;
  message:          string;
  createdAt:        string;
  acknowledgedAt?:  string;
  acknowledgedBy?:  string;
  resolvedAt?:      string;
}

export interface AlertFilters {
  status?:   AlertStatus;
  severity?: AlertSeverity;
  siteId?:   string;
  page?:     number;
  limit?:    number;
}

// ── Alert settings ─────────────────────────────────────────────────────────────

export interface NotificationPreferences {
  emailEnabled:    boolean;
  smsEnabled:      boolean;
  emailAddresses:  string[];
  phoneNumbers:    string[];
}

export interface AlertThreshold {
  metricType:     string;
  warningValue:   number;
  criticalValue:  number;
  unit:           string;
}

export interface AlertSettings {
  preferences:  NotificationPreferences;
  thresholds:   AlertThreshold[];
}

// ── Inventory history ──────────────────────────────────────────────────────────

export interface InventorySnapshot {
  date:              string;  // "YYYY-MM-DD"
  siteId:            string;
  totalVolumeCubicM: number;
  totalQuantity:     number;
  itemCount:         number;
}

// ── Pagination ─────────────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  data:       T[];
  total:      number;
  page:       number;
  limit:      number;
  totalPages: number;
}

// ── API error ──────────────────────────────────────────────────────────────────

export interface ApiError {
  error: {
    code:    string;
    message: string;
  };
}
