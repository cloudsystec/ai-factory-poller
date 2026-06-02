import { createClient } from "redis";

/** @type {import("redis").RedisClientType | null} */
let commandClient = null;

export function getRedisUrl() {
  return process.env.REDIS_URL || "redis://127.0.0.1:6379";
}

/**
 * @returns {Promise<import("redis").RedisClientType>}
 */
export async function getCommandRedis() {
  if (!commandClient) {
    commandClient = createClient({ url: getRedisUrl() });
    commandClient.on("error", (err) => {
      console.error("[redis-client]", err.message);
    });
    await commandClient.connect();
  }
  return commandClient;
}
