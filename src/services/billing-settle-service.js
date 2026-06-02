/**
 * Settle billing — funções usadas pelo poller.
 * Espelho de ai-factory-back/src/services/billing-call-service.js (subset poller).
 */
import { query, getPool } from "../db/pool.js";
import { normalizeCursorChargeToCents } from "../lib/cursor-charge-cents.js";
import { aggregateJobChargeSource } from "../lib/charge-source.js";
import { chargedCentsToCostBaseUsd } from "../lib/billing-cursor-match.js";

const SETTLE_GRACE_SECONDS = 5;
const POLL_BATCH_LIMIT = 50;

/**
 * @param {import('pg').PoolClient} client
 */
async function insertClaimsWithClient(client, input) {
  const { tenantId, botEmail, jobId, callId, claims } = input;
  const inserted = [];
  const conflictKeys = [];

  for (const claim of claims) {
    const { rows } = await client.query(
      `INSERT INTO billing_cursor_event_claims (
         tenant_id, bot_email, cursor_event_key, event_timestamp_ms,
         charged_cents, job_id, call_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, bot_email, cursor_event_key) DO NOTHING
       RETURNING cursor_event_key`,
      [
        tenantId,
        botEmail,
        claim.key,
        claim.eventTimestampMs,
        normalizeCursorChargeToCents(claim.chargedCents),
        jobId,
        callId,
      ]
    );
    if (rows[0]) {
      inserted.push(rows[0].cursor_event_key);
    } else {
      conflictKeys.push(claim.key);
    }
  }

  return { inserted, conflictKeys };
}

/**
 * @param {Date|string|number|null|undefined} startedAt
 * @param {Date|string|number|null|undefined} endedAt
 */
export function billingCallAnchorMs(startedAt, endedAt) {
  const ended = endedAt != null ? new Date(endedAt).getTime() : NaN;
  const started = startedAt != null ? new Date(startedAt).getTime() : NaN;
  if (Number.isFinite(ended)) return ended;
  if (Number.isFinite(started)) return started;
  return NaN;
}

/**
 * @param {number} [limit]
 */
export async function listCallsAwaitingCursorSettle(limit = POLL_BATCH_LIMIT) {
  const lim = Math.min(Math.max(Number(limit) || POLL_BATCH_LIMIT, 1), 100);
  const { rows } = await query(
    `SELECT c.id,
            c.tenant_id,
            c.job_id,
            c.started_at,
            c.ended_at,
            c.meta,
            COALESCE(
              NULLIF(TRIM(c.meta->>'botEmail'), ''),
              tw.cursor_bot_email
            ) AS bot_email
     FROM billing_ai_calls c
     LEFT JOIN work_locks wl ON wl.job_id = c.job_id
     LEFT JOIN tenant_workers tw
       ON tw.tenant_id = c.tenant_id AND tw.worker_slot = wl.worker_slot
     WHERE c.status IN ('pending', 'estimated')
       AND c.source IS DISTINCT FROM 'cursor_admin_api'
       AND COALESCE(c.ended_at, c.started_at)
         + make_interval(secs => $2::double precision) < now()
     ORDER BY COALESCE(c.ended_at, c.started_at) ASC
     LIMIT $1`,
    [lim, SETTLE_GRACE_SECONDS]
  );
  return rows;
}

/**
 * @param {string} tenantId
 * @param {string} botEmail
 * @param {{ sinceMs: number, untilMs: number }} range
 * @returns {Promise<string[]>}
 */
export async function loadConsumedKeys(tenantId, botEmail, range) {
  const email = String(botEmail || "").trim().toLowerCase();
  if (!email) return [];
  const since = Number(range.sinceMs) || 0;
  const until = Number(range.untilMs) || Date.now();
  const { rows } = await query(
    `SELECT cursor_event_key FROM billing_cursor_event_claims
     WHERE tenant_id = $1 AND bot_email = $2
       AND event_timestamp_ms >= $3 AND event_timestamp_ms <= $4`,
    [tenantId, email, since, until]
  );
  return rows.map((r) => r.cursor_event_key);
}

/**
 * Aplica match Cursor (1 evento) numa chamada — uso do poller.
 * @param {{
 *   tenantId: string,
 *   callId: string,
 *   jobId: string,
 *   botEmail: string,
 *   match: { key: string, eventTimestampMs: number, chargedCents: number, matchDeltaMs: number },
 * }} input
 * @returns {Promise<{ ok: boolean, costBaseUsd: number, claimSkipped: boolean }>}
 */
export async function applyCursorMatchToCall(input) {
  const { tenantId, callId, jobId, botEmail, match } = input;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const claimResult = await insertClaimsWithClient(client, {
      tenantId,
      botEmail,
      jobId,
      callId,
      claims: [
        {
          key: match.key,
          eventTimestampMs: match.eventTimestampMs,
          chargedCents: match.chargedCents,
        },
      ],
    });

    if (claimResult.inserted.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, costBaseUsd: 0, claimSkipped: true };
    }

    const costBaseUsd = chargedCentsToCostBaseUsd(match.chargedCents);

    await client.query(
      `UPDATE billing_ai_calls SET
         status = 'settled',
         cost_base_usd = $3,
         source = 'cursor_admin_api',
         match_delta_ms = $4,
         cursor_matched_event_ms = $5,
         updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [
        callId,
        tenantId,
        costBaseUsd,
        match.matchDeltaMs,
        match.eventTimestampMs,
      ]
    );

    await client.query("COMMIT");
    return { ok: true, costBaseUsd, claimSkipped: false };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * @param {string} tenantId
 * @param {string} jobId
 */
export async function sumJobBillingCalls(tenantId, jobId) {
  const { rows } = await query(
    `SELECT cost_base_usd, source, status
     FROM billing_ai_calls
     WHERE tenant_id = $1 AND job_id = $2
       AND source IS DISTINCT FROM 'skipped'`,
    [tenantId, jobId]
  );

  let totalCostBaseUsd = 0;
  const sources = [];
  let openCount = 0;

  for (const r of rows) {
    totalCostBaseUsd += Number(r.cost_base_usd) || 0;
    sources.push(r.source || "pending");
    if (r.status !== "settled" || r.source !== "cursor_admin_api") {
      openCount += 1;
    }
  }

  totalCostBaseUsd =
    Math.round(totalCostBaseUsd * 1_000_000) / 1_000_000;

  return {
    totalCostBaseUsd,
    chargeSource: aggregateJobChargeSource(sources),
    callCount: rows.length,
    openCount,
  };
}

/**
 * Todas as calls do job estão settled (ou skipped)?
 * @param {string} tenantId
 * @param {string} jobId
 */
export async function areAllJobCallsSettled(tenantId, jobId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS open
     FROM billing_ai_calls
     WHERE tenant_id = $1 AND job_id = $2
       AND source IS DISTINCT FROM 'skipped'
       AND (status <> 'settled' OR source IS DISTINCT FROM 'cursor_admin_api')`,
    [tenantId, jobId]
  );
  return (rows[0]?.open || 0) === 0;
}
