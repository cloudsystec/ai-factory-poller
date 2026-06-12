import { getPool } from "../db/pool.js";
import { normalizeChargeSource } from "../lib/charge-source.js";
import { computeCharge } from "../billing/compute-charge.js";

/**
 * Atualiza apenas o custo de um job já completado, ajustando
 * o balance do tenant pela diferença (novo - antigo).
 * @param {string} tenantId
 * @param {string} jobId
 * @param {{ costBaseUsd: number, chargeSource?: string }} payload
 */
export async function updateJobBilling(tenantId, jobId, payload) {
  const newCb = Number(payload.costBaseUsd) || 0;
  const chargeSource = normalizeChargeSource(
    payload.chargeSource || "cursor_admin_api"
  );
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT cost_base_usd, charge_usd, status FROM jobs
       WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId]
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    const oldCb = Number(rows[0].cost_base_usd) || 0;
    const oldCc = Number(rows[0].charge_usd) || 0;
    const billingStatus =
      rows[0].status === "cancelled" ? "cancelled" : "completed";
    const { cc: newCc } = computeCharge(newCb, billingStatus);
    const chargeDelta = newCc - oldCc;

    await client.query(
      `UPDATE jobs SET cost_base_usd = $3, charge_usd = $4, charge_source = $5
       WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId, newCb, newCc, chargeSource]
    );
    await client.query(
      `UPDATE usage_events SET cost_base_usd = $2, charge_usd = $3, charge_source = $4
       WHERE job_id = $1 AND tenant_id = $5`,
      [jobId, newCb, newCc, chargeSource, tenantId]
    );
    if (chargeDelta !== 0) {
      await client.query(
        `UPDATE tenants SET balance_usd = balance_usd - $2, updated_at = now()
         WHERE id = $1`,
        [tenantId, chargeDelta]
      );
    }
    await client.query("COMMIT");
    return { oldCb, newCb, oldCc, newCc, chargeDelta };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
