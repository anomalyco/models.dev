export interface HitPayload {
  method?: string;
  path?: string;
  useragent?: string;
  ip?: string;
  cf_country?: string;
}

// The platform lake projects these payload fields into its `models.hit` table.
// Backfills must use the same mapping as live hits.
export function hitEvent(timestamp: string, payload: HitPayload) {
  return { source: "models", type: "hit", timestamp, payload };
}
