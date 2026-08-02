import bcrypt from "bcrypt";
import Setting from "../../models/Setting.js";
import { timingSafeEqualUtf8 } from "./labelRoutingHelpers.js";

const NS = "WAREHOUSE";

export const LABEL_SETTING_KEYS = Object.freeze({
  ENABLED: "LABEL_ENABLED",
  DEFAULT_PRINTER_CODE: "LABEL_DEFAULT_PRINTER_CODE",
  AUTO_PRINT_AFTER_GRN: "LABEL_AUTO_PRINT_AFTER_GRN",
  ALLOW_MANUAL_REPRINT: "LABEL_ALLOW_MANUAL_REPRINT",
  MAX_PER_JOB: "LABEL_MAX_PER_JOB",
  DEFAULT_COPIES: "LABEL_DEFAULT_COPIES",
  /** bcrypt hash of bootstrap token (never plaintext at rest when set via API) */
  AGENT_BOOTSTRAP_TOKEN_HASH: "LABEL_AGENT_BOOTSTRAP_TOKEN_HASH",
  /** Legacy plaintext key — migrated on verify; cleared after hash migration */
  AGENT_BOOTSTRAP_TOKEN: "LABEL_AGENT_BOOTSTRAP_TOKEN",
  AGENT_BOOTSTRAP_ENABLED: "LABEL_AGENT_BOOTSTRAP_ENABLED",
  AGENT_BOOTSTRAP_EXPIRES_AT: "LABEL_AGENT_BOOTSTRAP_EXPIRES_AT",
  AGENT_BOOTSTRAP_WAREHOUSE: "LABEL_AGENT_BOOTSTRAP_WAREHOUSE",
  AGENT_BOOTSTRAP_MAX_USES: "LABEL_AGENT_BOOTSTRAP_MAX_USES",
  AGENT_BOOTSTRAP_USE_COUNT: "LABEL_AGENT_BOOTSTRAP_USE_COUNT",
});

export const LABEL_SETTING_DEFAULTS = Object.freeze({
  [LABEL_SETTING_KEYS.ENABLED]: false,
  [LABEL_SETTING_KEYS.DEFAULT_PRINTER_CODE]: "",
  [LABEL_SETTING_KEYS.AUTO_PRINT_AFTER_GRN]: false,
  [LABEL_SETTING_KEYS.ALLOW_MANUAL_REPRINT]: true,
  [LABEL_SETTING_KEYS.MAX_PER_JOB]: 200,
  [LABEL_SETTING_KEYS.DEFAULT_COPIES]: 1,
  [LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_TOKEN_HASH]: "",
  [LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_TOKEN]: "",
  [LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_ENABLED]: false,
  [LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_EXPIRES_AT]: "",
  [LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_WAREHOUSE]: "",
  [LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_MAX_USES]: 0,
  [LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_USE_COUNT]: 0,
});

function companyFilter(companyId) {
  return { companyId, branchId: null, namespace: NS };
}

async function setSetting(companyId, key, value, updatedBy = "") {
  await Setting.findOneAndUpdate(
    { ...companyFilter(companyId), key },
    {
      $set: {
        value,
        description: `Warehouse label setting ${key}`,
        updatedBy: String(updatedBy || ""),
      },
      $setOnInsert: {
        companyId,
        branchId: null,
        namespace: NS,
        key,
      },
    },
    { upsert: true, new: true }
  );
}

export async function getLabelSettings(companyId) {
  const rows = await Setting.find({
    ...companyFilter(companyId),
    key: { $in: Object.values(LABEL_SETTING_KEYS) },
  }).lean();
  const map = { ...LABEL_SETTING_DEFAULTS };
  for (const r of rows) {
    map[r.key] = r.value;
  }
  const hasHash = Boolean(String(map[LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_TOKEN_HASH] || ""));
  const hasLegacyPlain = Boolean(String(map[LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_TOKEN] || ""));
  const hasSecret = hasHash || hasLegacyPlain;
  return {
    enabled: Boolean(map[LABEL_SETTING_KEYS.ENABLED]),
    defaultPrinterCode: String(map[LABEL_SETTING_KEYS.DEFAULT_PRINTER_CODE] || ""),
    autoPrintAfterGrn: Boolean(map[LABEL_SETTING_KEYS.AUTO_PRINT_AFTER_GRN]),
    allowManualReprint: map[LABEL_SETTING_KEYS.ALLOW_MANUAL_REPRINT] !== false,
    maxPerJob: Math.max(1, Number(map[LABEL_SETTING_KEYS.MAX_PER_JOB]) || 200),
    defaultCopies: Math.max(1, Number(map[LABEL_SETTING_KEYS.DEFAULT_COPIES]) || 1),
    /** Never expose plaintext or hash to API consumers via this object field */
    agentBootstrapToken: "",
    hasAgentBootstrapToken: hasSecret,
    agentBootstrapEnabled: hasSecret && map[LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_ENABLED] !== false,
    agentBootstrapExpiresAt: String(map[LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_EXPIRES_AT] || ""),
    agentBootstrapWarehouse: String(map[LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_WAREHOUSE] || "")
      .trim()
      .toUpperCase(),
    agentBootstrapMaxUses: Math.max(0, Number(map[LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_MAX_USES]) || 0),
    agentBootstrapUseCount: Math.max(0, Number(map[LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_USE_COUNT]) || 0),
  };
}

/** Internal: load raw bootstrap secrets for verification only. */
export async function getBootstrapSecretMaterial(companyId) {
  const rows = await Setting.find({
    ...companyFilter(companyId),
    key: {
      $in: [
        LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_TOKEN_HASH,
        LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_TOKEN,
        LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_ENABLED,
        LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_EXPIRES_AT,
        LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_WAREHOUSE,
        LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_MAX_USES,
        LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_USE_COUNT,
      ],
    },
  }).lean();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  const hash = String(map[LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_TOKEN_HASH] || "");
  const legacyPlain = String(map[LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_TOKEN] || "");
  const hasSecret = Boolean(hash || legacyPlain);
  const enabledFlag = map[LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_ENABLED];
  return {
    hash,
    legacyPlain,
    // Explicit false disables; otherwise enabled when a secret exists (legacy plaintext migration)
    enabled: hasSecret && enabledFlag !== false,
    expiresAt: String(map[LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_EXPIRES_AT] || ""),
    warehouse: String(map[LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_WAREHOUSE] || "")
      .trim()
      .toUpperCase(),
    maxUses: Math.max(0, Number(map[LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_MAX_USES]) || 0),
    useCount: Math.max(0, Number(map[LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_USE_COUNT]) || 0),
  };
}

export async function verifyBootstrapToken(companyId, presentedToken) {
  const material = await getBootstrapSecretMaterial(companyId);
  if (!material.enabled) {
    const err = new Error("Agent bootstrap is disabled");
    err.code = "AGENT_BOOTSTRAP_DISABLED";
    err.statusCode = 403;
    throw err;
  }
  if (material.expiresAt) {
    const exp = Date.parse(material.expiresAt);
    if (Number.isFinite(exp) && Date.now() > exp) {
      const err = new Error("Bootstrap token expired");
      err.code = "AGENT_BOOTSTRAP_EXPIRED";
      err.statusCode = 401;
      throw err;
    }
  }
  if (material.maxUses > 0 && material.useCount >= material.maxUses) {
    const err = new Error("Bootstrap token use limit reached");
    err.code = "AGENT_BOOTSTRAP_EXHAUSTED";
    err.statusCode = 401;
    throw err;
  }
  const token = String(presentedToken || "");
  let ok = false;
  if (material.hash) {
    ok = await bcrypt.compare(token, material.hash);
  } else if (material.legacyPlain) {
    ok = timingSafeEqualUtf8(material.legacyPlain, token);
    if (ok) {
      // Migrate legacy plaintext → hash and clear plaintext
      const hash = await bcrypt.hash(token, 10);
      await setSetting(companyId, LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_TOKEN_HASH, hash, "bootstrap-migrate");
      await setSetting(companyId, LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_TOKEN, "", "bootstrap-migrate");
      await setSetting(companyId, LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_ENABLED, true, "bootstrap-migrate");
    }
  }
  if (!ok) {
    const err = new Error("Invalid bootstrap token");
    err.code = "AGENT_BOOTSTRAP_INVALID";
    err.statusCode = 401;
    throw err;
  }
  return material;
}

export async function incrementBootstrapUseCount(companyId) {
  const material = await getBootstrapSecretMaterial(companyId);
  await setSetting(
    companyId,
    LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_USE_COUNT,
    material.useCount + 1,
    "bootstrap"
  );
}

export async function upsertLabelSettings(companyId, patch = {}, updatedBy = "") {
  const allowed = {
    enabled: LABEL_SETTING_KEYS.ENABLED,
    defaultPrinterCode: LABEL_SETTING_KEYS.DEFAULT_PRINTER_CODE,
    autoPrintAfterGrn: LABEL_SETTING_KEYS.AUTO_PRINT_AFTER_GRN,
    allowManualReprint: LABEL_SETTING_KEYS.ALLOW_MANUAL_REPRINT,
    maxPerJob: LABEL_SETTING_KEYS.MAX_PER_JOB,
    defaultCopies: LABEL_SETTING_KEYS.DEFAULT_COPIES,
    agentBootstrapEnabled: LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_ENABLED,
    agentBootstrapExpiresAt: LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_EXPIRES_AT,
    agentBootstrapWarehouse: LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_WAREHOUSE,
    agentBootstrapMaxUses: LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_MAX_USES,
  };

  for (const [field, key] of Object.entries(allowed)) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    let value = patch[field];
    if (field === "maxPerJob" || field === "defaultCopies" || field === "agentBootstrapMaxUses") {
      value = Math.max(0, Number(value) || 0);
      if (field !== "agentBootstrapMaxUses") value = Math.max(1, value || 1);
    }
    if (field === "enabled" || field === "autoPrintAfterGrn" || field === "allowManualReprint" || field === "agentBootstrapEnabled") {
      value = Boolean(value);
    }
    if (field === "defaultPrinterCode" || field === "agentBootstrapWarehouse") {
      value = String(value || "").trim().toUpperCase();
    }
    if (field === "agentBootstrapExpiresAt") value = String(value || "").trim();
    await setSetting(companyId, key, value, updatedBy);
  }

  // Bootstrap token: hash at rest; never store plaintext from API
  if (Object.prototype.hasOwnProperty.call(patch, "agentBootstrapToken")) {
    const plain = String(patch.agentBootstrapToken || "").trim();
    if (plain) {
      const hash = await bcrypt.hash(plain, 10);
      await setSetting(companyId, LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_TOKEN_HASH, hash, updatedBy);
      await setSetting(companyId, LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_TOKEN, "", updatedBy);
      await setSetting(companyId, LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_ENABLED, true, updatedBy);
      await setSetting(companyId, LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_USE_COUNT, 0, updatedBy);
    } else if (plain === "" && patch.clearBootstrapToken) {
      await setSetting(companyId, LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_TOKEN_HASH, "", updatedBy);
      await setSetting(companyId, LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_TOKEN, "", updatedBy);
      await setSetting(companyId, LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_ENABLED, false, updatedBy);
    }
  }

  return getLabelSettings(companyId);
}
