import mongoose from "mongoose";

export function isMongoTransactionUnsupported(err) {
  const msg = String(err?.message || err?.errmsg || "");
  const code = err?.code;
  return (
    msg.includes("Transaction numbers are only allowed") ||
    msg.includes("Transaction numbers are not allowed") ||
    msg.includes("replica set") ||
    msg.includes("not supported") ||
    code === 20 ||
    code === 263
  );
}

export function mongoTransactionUnavailableError(cause) {
  const e = new Error(
    "This operation requires MongoDB replica-set transactions. No changes were applied."
  );
  e.statusCode = 503;
  e.code = "MONGO_TX_REQUIRED";
  e.cause = cause;
  return e;
}

/**
 * Run fn(session) inside a MongoDB transaction.
 * Does not fall back to sequential writes. If transactions are unavailable, fails clearly.
 */
export async function runMongoTransaction(fn) {
  let session;
  try {
    session = await mongoose.startSession();
  } catch (err) {
    throw mongoTransactionUnavailableError(err);
  }
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    if (isMongoTransactionUnsupported(err) || err?.code === "MONGO_TX_REQUIRED") {
      throw mongoTransactionUnavailableError(err);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}
