/**
 * @param {number} cb Custo base (USD)
 * @returns {number}
 */
export function computeTokenFee(cb) {
  const n = Number(cb);
  if (!Number.isFinite(n) || n < 0) return 0.01;
  return Math.max(0.01, n * 0.15);
}

/**
 * @param {number} cb
 * @param {'completed'|'failed'|'cancelled'|string} status
 * @returns {{ cc: number, debitCb: boolean, fee: number }}
 */
export function computeCharge(cb, status) {
  const base = Number(cb);
  const safeCb = Number.isFinite(base) && base >= 0 ? base : 0;
  if (status === "cancelled") {
    const fee = computeTokenFee(safeCb);
    return { cc: fee, debitCb: false, fee };
  }
  const fee = computeTokenFee(safeCb);
  return { cc: safeCb + fee, debitCb: true, fee };
}
