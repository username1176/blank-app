import { env } from "../config/env";

// ---------------------------------------------------------------------------
// Topic hierarchy
// ---------------------------------------------------------------------------
//
//  {prefix} / {customerId} / site / {siteId} / sensor / {sensorId} / readings
//     [0]        [1]          [2]     [3]        [4]       [5]          [6]
//
// MQTT single-level wildcard (+) matches exactly one segment.
// ---------------------------------------------------------------------------

export interface TopicParams {
  customerId: string;
  siteId:     string;
  sensorId:   string;
}

/** Wildcard topic the service subscribes to. */
export function subscriptionTopic(): string {
  return `${env.MQTT_TOPIC_PREFIX}/+/site/+/sensor/+/readings`;
}

/** Build the canonical publish topic for a specific sensor. */
export function buildTopic(params: TopicParams): string {
  const { customerId, siteId, sensorId } = params;
  return `${env.MQTT_TOPIC_PREFIX}/${customerId}/site/${siteId}/sensor/${sensorId}/readings`;
}

/**
 * Parse a received topic into its constituent IDs.
 * Returns null when the topic does not match the expected structure.
 */
export function parseTopic(topic: string): TopicParams | null {
  const parts = topic.split("/");

  // Expected length: 7 segments
  if (parts.length !== 7) return null;

  const [prefix, customerId, site, siteId, sensor, sensorId, suffix] = parts;

  if (
    prefix     !== env.MQTT_TOPIC_PREFIX ||
    site       !== "site"               ||
    sensor     !== "sensor"             ||
    suffix     !== "readings"           ||
    !customerId ||
    !siteId    ||
    !sensorId
  ) {
    return null;
  }

  return { customerId, siteId, sensorId };
}
