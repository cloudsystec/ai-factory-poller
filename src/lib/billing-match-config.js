/** Máx. distância |evento Cursor − started_at| para match (ms). */
export function billingMatchDeltaMs() {
  const raw = Number(process.env.BILLING_MAX_MATCH_DELTA_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

export function cursorUsageStartBufferMs() {
  const raw = Number(process.env.CURSOR_USAGE_START_BUFFER_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 120_000;
}

export function cursorUsageEndBufferMs() {
  const raw = Number(process.env.CURSOR_USAGE_END_BUFFER_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
}

/** Estimativa de duração máxima de uma call IA para janela de fetch (ms). */
export function cursorUsageDurationEstimateMs() {
  const raw = Number(process.env.CURSOR_USAGE_DURATION_ESTIMATE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 600_000;
}
