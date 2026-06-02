import { createLogger } from "./lib/logger.js";
import { fetchAllFilteredUsageEvents } from "./lib/cursor-admin-api.js";
import { pickBestCursorEvent } from "./lib/billing-cursor-match.js";
import {
  cursorUsageDurationEstimateMs,
  cursorUsageEndBufferMs,
  cursorUsageStartBufferMs,
} from "./lib/billing-match-config.js";
import {
  billingCallAnchorMs,
  listCallsAwaitingCursorSettle,
  loadConsumedKeys,
  applyCursorMatchToCall,
  areAllJobCallsSettled,
  sumJobBillingCalls,
} from "./services/billing-settle-service.js";
import { getTenantCursorAdminApiKey } from "./services/tenant-cursor-key.js";
import { updateJobBilling } from "./services/job-billing-service.js";
import { query } from "./db/pool.js";

const log = createLogger("billing-poller");

/**
 * Settle incremental: calls por started_at ASC; match ancora em started_at;
 * eventos Cursor já claimados saem do pool; desempate pelo timestamp mais antigo.
 */

/** @type {ReturnType<typeof setInterval>|null} */
let intervalHandle = null;
let tickRunning = false;

function pollIntervalMs() {
  const raw = Number(process.env.BILLING_CURSOR_POLL_INTERVAL_MS);
  const ms = Number.isFinite(raw) && raw > 0 ? raw : 5000;
  return Math.max(1000, ms);
}

/**
 * @param {string} tenantId
 * @param {string} jobId
 */
async function maybeRefreshJobBilling(tenantId, jobId) {
  const { rows } = await query(
    `SELECT status FROM jobs WHERE id = $1 AND tenant_id = $2`,
    [jobId, tenantId]
  );
  const status = rows[0]?.status;
  if (status !== "completed" && status !== "cancelled") return;

  const allSettled = await areAllJobCallsSettled(tenantId, jobId);
  if (!allSettled) return;

  const summary = await sumJobBillingCalls(tenantId, jobId);
  const result = await updateJobBilling(tenantId, jobId, {
    costBaseUsd: summary.totalCostBaseUsd,
    chargeSource: summary.chargeSource,
  });
  if (result) {
    log.info("Job billing atualizado após settle das calls", {
      jobId,
      totalCostBaseUsd: summary.totalCostBaseUsd,
      chargeSource: summary.chargeSource,
    });
    const { notifyBillingUpdate } = await import("./lib/billing-notify.js");
    await notifyBillingUpdate(tenantId, { type: "billing" });
  }
}

/**
 * @param {Map<string, { events: object[], apiKey: string }>} fetchCache
 * @param {{ tenant_id: string, bot_email: string, started_at: Date, latest_start_at: Date }} group
 */
async function loadEventsForGroup(fetchCache, group) {
  const cacheKey = `${group.tenant_id}|${group.bot_email}`;
  if (fetchCache.has(cacheKey)) return fetchCache.get(cacheKey);

  const apiKey = await getTenantCursorAdminApiKey(group.tenant_id);
  if (!apiKey) {
    fetchCache.set(cacheKey, { events: [], apiKey: "" });
    return fetchCache.get(cacheKey);
  }

  const startMs = group.started_at.getTime() - cursorUsageStartBufferMs();
  const endMs =
    group.latest_start_at.getTime() +
    cursorUsageDurationEstimateMs() +
    cursorUsageEndBufferMs();
  try {
    const { events } = await fetchAllFilteredUsageEvents(apiKey, {
      startDate: startMs,
      endDate: endMs,
      email: group.bot_email || undefined,
    });
    const entry = { events, apiKey };
    fetchCache.set(cacheKey, entry);
    return entry;
  } catch (e) {
    log.warn("Cursor API falhou no poller", {
      tenantId: group.tenant_id,
      botEmail: group.bot_email,
      error: e instanceof Error ? e.message : String(e),
    });
    const entry = { events: [], apiKey: "" };
    fetchCache.set(cacheKey, entry);
    return entry;
  }
}

/**
 * @param {Map<string, Promise<Set<string>>>} consumedCache
 * @param {{ tenant_id: string, bot_email: string, started_at: Date, latest_start_at: Date }} group
 */
async function loadTickConsumedForGroup(consumedCache, group) {
  const cacheKey = `${group.tenant_id}|${group.bot_email}`;
  if (!consumedCache.has(cacheKey)) {
    const sinceMs = group.started_at.getTime() - cursorUsageStartBufferMs();
    const untilMs =
      group.latest_start_at.getTime() +
      cursorUsageDurationEstimateMs() +
      cursorUsageEndBufferMs();
    const promise = loadConsumedKeys(group.tenant_id, group.bot_email, {
      sinceMs,
      untilMs,
    }).then((keys) => new Set(keys));
    consumedCache.set(cacheKey, promise);
  }
  return consumedCache.get(cacheKey);
}

export async function runBillingSettleTick() {
  if (tickRunning) return;
  tickRunning = true;

  let matched = 0;
  let skipped = 0;
  let claimSkipped = 0;

  try {
    const calls = await listCallsAwaitingCursorSettle();
    if (calls.length === 0) return;

    const fetchCache = new Map();
    const consumedCache = new Map();
    const tenantsBroadcast = new Set();

    const groups = new Map();
    for (const call of calls) {
      const botEmail = String(call.bot_email || "").trim().toLowerCase();
      if (!botEmail) {
        skipped += 1;
        continue;
      }
      const key = `${call.tenant_id}|${botEmail}`;
      const startedMs = billingCallAnchorMs(call.started_at);
      if (!Number.isFinite(startedMs)) {
        skipped += 1;
        continue;
      }
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          tenant_id: call.tenant_id,
          bot_email: botEmail,
          started_at: new Date(startedMs),
          latest_start_at: new Date(startedMs),
        });
      } else {
        if (startedMs < existing.started_at.getTime()) {
          existing.started_at = new Date(startedMs);
        }
        if (startedMs > existing.latest_start_at.getTime()) {
          existing.latest_start_at = new Date(startedMs);
        }
      }
    }

    for (const call of calls) {
      const botEmail = String(call.bot_email || "").trim().toLowerCase();
      if (!botEmail) continue;

      const groupKey = `${call.tenant_id}|${botEmail}`;
      const group = groups.get(groupKey);
      if (!group) continue;

      const { events } = await loadEventsForGroup(fetchCache, group);
      const tickConsumed = await loadTickConsumedForGroup(consumedCache, group);

      const startedMs = billingCallAnchorMs(call.started_at);
      if (!Number.isFinite(startedMs)) continue;

      const match = pickBestCursorEvent({
        startedMs,
        events,
        consumedKeys: tickConsumed,
        email: botEmail,
      });

      if (!match) continue;

      const result = await applyCursorMatchToCall({
        tenantId: call.tenant_id,
        callId: call.id,
        jobId: call.job_id,
        botEmail,
        match,
      });

      tickConsumed.add(match.key);

      if (result.claimSkipped) {
        claimSkipped += 1;
        log.debug("Evento Cursor já claimado — call permanece pendente neste tick", {
          callId: call.id,
          eventKey: match.key,
        });
        continue;
      }

      if (result.ok) {
        matched += 1;
        tenantsBroadcast.add(call.tenant_id);
        await maybeRefreshJobBilling(call.tenant_id, call.job_id);
      }
    }

    if (tenantsBroadcast.size > 0) {
      const { notifyBillingUpdate } = await import("./lib/billing-notify.js");
      for (const tenantId of tenantsBroadcast) {
        await notifyBillingUpdate(tenantId, { type: "billing" });
      }
    }

    if (matched > 0 || skipped > 0 || claimSkipped > 0) {
      log.info("Tick billing poller", {
        pending: calls.length,
        matched,
        skippedNoEmail: skipped,
        claimSkipped,
      });
    }
  } catch (e) {
    log.warn("Tick billing poller falhou", {
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    tickRunning = false;
  }
}

export function startBillingSettlePoller() {
  if (intervalHandle) return;

  const intervalMs = pollIntervalMs();
  log.info("Billing poller iniciado", { intervalMs });

  void runBillingSettleTick();
  intervalHandle = setInterval(() => {
    void runBillingSettleTick();
  }, intervalMs);
}

export function stopBillingSettlePoller() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
