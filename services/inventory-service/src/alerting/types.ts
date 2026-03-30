// =============================================================================
// Alerting domain types
// =============================================================================

// ---------------------------------------------------------------------------
// Kafka event — published to the `alerts` topic
// ---------------------------------------------------------------------------

export interface DropAlertDetails {
  currentVolumeM3:   number;
  referenceVolumeM3: number;
  dropPct:           number;
  thresholdPct:      number;
  lookbackMinutes:   number;
  detectedAt:        string; // ISO 8601
}

export interface AlertEvent {
  /** UUID generated at publish time — idempotency key for downstream consumers. */
  id:         string;
  type:       "inventory_drop";
  severity:   "info" | "warning" | "critical";
  customerId: string;
  siteId:     string;
  pileId:     string;
  pileName:   string;
  message:    string;
  details:    DropAlertDetails;
  /** ISO 8601 */
  createdAt:  string;
}

// ---------------------------------------------------------------------------
// Alert configuration row (mirrors alert_configs table)
// ---------------------------------------------------------------------------

export type AlertType = "inventory_drop" | "inventory_discrepancy";
export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertConfig {
  id:               string;
  customerId:       string;
  siteId:           string | null;
  pileId:           string | null;
  alertType:        AlertType;
  dropThresholdPct: number;
  lookbackMinutes:  number;
  cooldownMinutes:  number;
  severity:         AlertSeverity;
  enabled:          boolean;
  createdAt:        Date;
  updatedAt:        Date;
}

/** The resolved config for a specific pile after precedence is applied. */
export interface ResolvedAlertConfig {
  configId:         string;
  dropThresholdPct: number;
  lookbackMinutes:  number;
  cooldownMinutes:  number;
  severity:         AlertSeverity;
}

// ---------------------------------------------------------------------------
// Pile descriptor used by the scheduler
// ---------------------------------------------------------------------------

export interface PileDescriptor {
  pileId:     string;
  pileName:   string;
  siteId:     string;
  customerId: string;
}
