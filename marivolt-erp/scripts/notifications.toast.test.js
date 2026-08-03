/**
 * Frontend notification / API-error acceptance tests (no browser required).
 */
import assert from "assert";
import {
  notify,
  registerToastHandler,
  confirmDialog,
  registerConfirmHandler,
} from "../src/lib/notifications.js";
import { resolveApiErrorMessage, safeNotifyText } from "../src/lib/apiError.js";

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

async function runAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

console.log("\nToast / notifications acceptance\n");

run("resolveApiErrorMessage: response.message", () => {
  const msg = resolveApiErrorMessage({
    response: { status: 400, data: { message: "Qty required" } },
    message: "Request failed",
  });
  assert.equal(msg, "Qty required");
});

run("resolveApiErrorMessage: validation array", () => {
  const msg = resolveApiErrorMessage({
    status: 422,
    body: { errors: [{ message: "Article missing" }, { message: "UOM invalid" }] },
  });
  assert.ok(msg.includes("Article missing"));
  assert.ok(msg.includes("UOM invalid"));
});

run("resolveApiErrorMessage: 401 fallback", () => {
  const msg = resolveApiErrorMessage({ status: 401, message: "" });
  assert.match(msg, /session/i);
});

run("resolveApiErrorMessage: 403 fallback", () => {
  const msg = resolveApiErrorMessage({ status: 403 });
  assert.match(msg, /Permission/i);
});

run("resolveApiErrorMessage: network", () => {
  const msg = resolveApiErrorMessage({ message: "Network Error", code: "ERR_NETWORK" });
  assert.match(msg, /Network/i);
});

run("resolveApiErrorMessage: never [object Object]", () => {
  const msg = resolveApiErrorMessage({ response: { data: { nested: { a: 1 } } } });
  assert.notEqual(msg, "[object Object]");
  assert.ok(msg.length > 0);
});

run("resolveApiErrorMessage: strips HTML-ish bodies", () => {
  const msg = resolveApiErrorMessage({
    status: 500,
    response: { status: 500, data: "<html><body>Error</body></html>" },
  });
  assert.doesNotMatch(msg, /<html>/i);
});

run("safeNotifyText: object with message", () => {
  assert.equal(safeNotifyText({ message: "Hello" }), "Hello");
});

run("safeNotifyText: avoids [object Object]", () => {
  assert.notEqual(safeNotifyText({}), "[object Object]");
});

{
  const received = [];
  const unreg = registerToastHandler((t) => received.push(t));

  run("notify.success emits typed toast", () => {
    received.length = 0;
    notify.success("Saved successfully.");
    assert.equal(received.length, 1);
    assert.equal(received[0].type, "success");
    assert.equal(received[0].message, "Saved successfully.");
    assert.ok(received[0].duration >= 3000 && received[0].duration <= 4000);
  });

  run("notify.error / warning / info durations", () => {
    received.length = 0;
    notify.error("Boom");
    notify.warning("Careful");
    notify.info("Working");
    assert.equal(received.length, 3);
    assert.equal(received[0].duration, 5000);
    assert.equal(received[1].duration, 5000);
    assert.equal(received[2].duration, 4000);
  });

  run("dedupe suppresses identical message+type", () => {
    received.length = 0;
    notify.success("Same message");
    notify.success("Same message");
    assert.equal(received.length, 1);
  });

  run("dedupeKey allows distinct messages", () => {
    received.length = 0;
    notify.error("A", { dedupeKey: "k1" });
    notify.error("B", { dedupeKey: "k2" });
    assert.equal(received.length, 2);
  });

  run("notify.fromError dedupes 401", () => {
    received.length = 0;
    notify.fromError({ status: 401, message: "Unauthorized" });
    notify.fromError({ status: 401, message: "Unauthorized again" });
    assert.equal(received.length, 1);
    assert.match(received[0].message, /session|Unauthorized/i);
  });

  run("toast ids are unique", () => {
    received.length = 0;
    notify.info("one-unique", { dedupe: false });
    notify.info("two-unique", { dedupe: false });
    notify.info("three-unique", { dedupe: false });
    const ids = new Set(received.map((t) => t.id));
    assert.equal(ids.size, received.length);
  });

  unreg();
}

await runAsync("confirmDialog resolves true/false once", async () => {
  let lastOpts = null;
  let resolveFn = null;
  const unreg = registerConfirmHandler((opts) => {
    lastOpts = opts;
    return new Promise((resolve) => {
      resolveFn = resolve;
    });
  });
  const p = confirmDialog({ title: "Delete item", message: "Really delete?", danger: true });
  assert.equal(lastOpts.danger, true);
  assert.equal(lastOpts.confirmLabel, "Yes");
  resolveFn(true);
  assert.equal(await p, true);

  const p2 = confirmDialog("Cancel this?");
  assert.equal(lastOpts.danger, true); // cancel keyword
  resolveFn(false);
  assert.equal(await p2, false);
  unreg();
});

await runAsync("confirmDialog disable infers danger", async () => {
  let lastOpts = null;
  const unreg = registerConfirmHandler((opts) => {
    lastOpts = opts;
    return Promise.resolve(false);
  });
  await confirmDialog("Disable printer?");
  assert.equal(lastOpts.danger, true);
  unreg();
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
