/* eslint-disable no-console */
import crypto from "crypto";

const API_BASE = (process.env.PHASE15_API_BASE || "http://localhost:5000/api").replace(/\/$/, "");
const TOKEN = String(process.env.PHASE15_TOKEN || "").trim();
const COMPANY_ID = String(process.env.PHASE15_COMPANY_ID || "").trim();
const OTHER_COMPANY_ID = String(process.env.PHASE15_OTHER_COMPANY_ID || "").trim();

if (!TOKEN || !COMPANY_ID) {
  console.error("Missing required env vars: PHASE15_TOKEN and PHASE15_COMPANY_ID");
  process.exit(1);
}

const DEFAULT_CODES = [
  "QUOTATION_FOLLOWUP",
  "PAYMENT_REMINDER",
  "DISPATCH_UPDATE",
  "SUPPLIER_ENQUIRY",
  "SHIPMENT_DELAY",
];

function randomObjectId() {
  return crypto.randomBytes(12).toString("hex");
}

async function req(path, { method = "GET", body, companyId = COMPANY_ID } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "x-company-id": companyId,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  return { status: res.status, ok: res.ok, json };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("Phase-15 smoke: start");

  // 1) Template seeding non-duplication
  const tpl1 = await req("/communication/templates");
  const tpl2 = await req("/communication/templates");
  assert(tpl1.ok && tpl2.ok, "Template list endpoint failed");
  for (const code of DEFAULT_CODES) {
    const count = (tpl2.json.items || []).filter((x) => x.templateCode === code).length;
    assert(count === 1, `Template duplication check failed for ${code}`);
  }
  console.log("OK: template seeding non-duplication");

  // 2) Linked document validation and create thread
  const invalidLinked = await req("/communication/threads", {
    method: "POST",
    body: {
      threadType: "CUSTOMER_COMMUNICATION",
      partyType: "CUSTOMER",
      partyName: "Smoke Invalid",
      partyEmail: "smoke.invalid@example.com",
      subject: "Invalid linked doc id",
      linkedDocuments: [{ documentType: "QUOTATION", documentId: "BAD_ID", documentNo: "" }],
    },
  });
  assert(invalidLinked.status === 400, "Invalid linked document ID should be rejected");
  console.log("OK: invalid linked document IDs rejected");

  const validDocId = randomObjectId();
  const created = await req("/communication/threads", {
    method: "POST",
    body: {
      threadType: "CUSTOMER_COMMUNICATION",
      partyType: "CUSTOMER",
      partyName: "Smoke Customer",
      partyEmail: "smoke.customer@example.com",
      subject: "Phase15 Smoke Thread",
      linkedDocuments: [{ documentType: "QUOTATION", documentId: validDocId, documentNo: "Q-SMOKE-001" }],
    },
  });
  assert(created.status === 201, "Thread create with linked document failed");
  const threadId = created.json._id;
  assert(Boolean(threadId), "Created thread id missing");
  console.log("OK: thread create with linked document");

  // 3) Status transitions + invalid transition rejection
  let step = await req(`/communication/threads/${threadId}/status`, { method: "POST", body: { status: "WAITING_REPLY" } });
  assert(step.ok && step.json.status === "WAITING_REPLY", "OPEN -> WAITING_REPLY failed");
  step = await req(`/communication/threads/${threadId}/status`, { method: "POST", body: { status: "CLOSED" } });
  assert(step.ok && step.json.status === "CLOSED", "WAITING_REPLY -> CLOSED failed");
  step = await req(`/communication/threads/${threadId}/status`, { method: "POST", body: { status: "OPEN" } });
  assert(step.ok && step.json.status === "OPEN", "CLOSED -> OPEN failed");
  const invalidTransition = await req(`/communication/threads/${threadId}/status`, { method: "POST", body: { status: "CLOSED" } });
  assert(invalidTransition.status === 400, "Invalid OPEN -> CLOSED transition should fail");
  console.log("OK: status transition rules");

  // 4) Filter validation (party, documentNo, status)
  const byParty = await req("/communication/threads?party=Smoke%20Customer");
  assert(byParty.ok && (byParty.json.items || []).some((x) => x._id === threadId), "Party filter failed");
  const byDoc = await req("/communication/threads?documentNo=Q-SMOKE-001");
  assert(byDoc.ok && (byDoc.json.items || []).some((x) => x._id === threadId), "Document no filter failed");
  await req(`/communication/threads/${threadId}/status`, { method: "POST", body: { status: "WAITING_REPLY" } });
  const byStatus = await req("/communication/threads?status=WAITING_REPLY");
  assert(byStatus.ok && (byStatus.json.items || []).some((x) => x._id === threadId), "Status filter failed");
  console.log("OK: thread filters (party/documentNo/status)");

  // 5) Portal visibility filter
  await req(`/communication/threads/${threadId}/portal-ready`, { method: "POST", body: { portalReference: "SMOKE-PORTAL-REF" } });
  await req(`/communication/threads/${threadId}/messages`, {
    method: "POST",
    body: {
      direction: "OUTBOUND",
      channel: "PORTAL",
      visibility: "CUSTOMER",
      portalVisible: true,
      message: "Customer visible message",
    },
  });
  const portalFiltered = await req("/communication/portal/documents?portalReference=SMOKE-PORTAL-REF&visibility=CUSTOMER");
  assert(portalFiltered.ok && (portalFiltered.json.messages || []).every((x) => x.visibility === "CUSTOMER"), "Portal visibility filter failed");
  console.log("OK: portal visibility filter");

  // 6) Token safety: invalid, expired, wrong scope
  const invalidToken = await req("/communication/portal/validate-token", { method: "POST", body: { token: "bad_token", portalReference: "SMOKE-PORTAL-REF" } });
  assert(invalidToken.status === 403, "Invalid token should be blocked");

  const expiredTokenCreate = await req("/communication/portal/access-tokens", {
    method: "POST",
    body: {
      partyType: "CUSTOMER",
      partyName: "Smoke Customer",
      partyEmail: "smoke.customer@example.com",
      portalReference: "SMOKE-PORTAL-REF",
      expiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    },
  });
  assert(expiredTokenCreate.status === 201, "Expired token setup failed");
  const expiredCheck = await req("/communication/portal/validate-token", {
    method: "POST",
    body: { token: expiredTokenCreate.json.token, portalReference: "SMOKE-PORTAL-REF" },
  });
  assert(expiredCheck.status === 403, "Expired token should be blocked");

  if (OTHER_COMPANY_ID) {
    const wrongCompany = await req("/communication/portal/validate-token", {
      method: "POST",
      body: { token: expiredTokenCreate.json.token, portalReference: "SMOKE-PORTAL-REF" },
      companyId: OTHER_COMPANY_ID,
    });
    assert(wrongCompany.status === 403, "Wrong company scope token should be blocked");
    console.log("OK: wrong company scope token blocked");
  } else {
    console.log("SKIP: wrong company scope check (PHASE15_OTHER_COMPANY_ID not set)");
  }

  console.log("Phase-15 smoke: completed successfully");
}

run().catch((err) => {
  console.error(`Phase-15 smoke failed: ${err.message}`);
  process.exit(1);
});

