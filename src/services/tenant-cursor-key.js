import { query } from "../db/pool.js";
import { decrypt } from "../lib/crypto.js";

/**
 * @param {string} tenantId
 * @returns {Promise<string|null>}
 */
export async function getTenantCursorAdminApiKey(tenantId) {
  const { rows } = await query(
    "SELECT cursor_admin_api_key_encrypted FROM tenants WHERE id = $1",
    [tenantId]
  );
  if (rows[0]?.cursor_admin_api_key_encrypted) {
    return decrypt(rows[0].cursor_admin_api_key_encrypted);
  }
  const platform = String(process.env.PLATFORM_CURSOR_ADMIN_API_KEY || "").trim();
  return platform || null;
}
