import { getCommandRedis } from "./redis-client.js";

/** Canal Redis para push de billing entre processos (poller → API). */
export function billingLiveChannel(tenantId) {
  return `aifactory:tenant:${tenantId}:billing`;
}

/**
 * Publica no Redis para a API fazer push WS ao front.
 * @param {string} tenantId
 * @param {object} [event]
 */
export async function notifyBillingUpdate(tenantId, event = { type: "billing" }) {
  try {
    const redis = await getCommandRedis();
    await redis.publish(billingLiveChannel(tenantId), JSON.stringify(event));
  } catch {
    /* Redis opcional em dev mínimo */
  }
}
