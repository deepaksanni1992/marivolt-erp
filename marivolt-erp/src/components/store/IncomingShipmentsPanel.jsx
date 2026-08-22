import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Modal from "../erp/Modal.jsx";
import AsnReceivingLabelPlanner from "./AsnReceivingLabelPlanner.jsx";
import ReceivingBarcodeScanner from "./ReceivingBarcodeScanner.jsx";
import ReceivingDispositionReview from "./ReceivingDispositionReview.jsx";
import ReceivingUnitInspectScreen from "./ReceivingUnitInspectScreen.jsx";
import { apiGet, apiGetWithQuery, apiPost } from "../../lib/api.js";
import { confirmDialog, notify } from "../../lib/notifications.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { AsnStatusBadge, formatAsnDate, incomingAsnListQuery, incomingShipmentsPath, trackingDisplay } from "../../lib/asnUi.js";
import { isStoreOperatorRole } from "../../lib/rbac.js";

export default function IncomingShipmentsPanel() {
  const { can, role } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const canPrepareLabels = can("ASN", "view") && can("LABELS", "print");
  const canReprint = can("LABELS", "reprint");
  const canReceive = can("ASN", "view") && can("STORE", "create");
  const canPostGrn = can("STORE", "post") || can("STORE", "approve");
  const canOpenAsnRegister = can("ASN", "view") && !isStoreOperatorRole(role);
  const [status, setStatus] = useState("incoming");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [plannerIntent, setPlannerIntent] = useState("review");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanError, setScanError] = useState("");
  const [inspect, setInspect] = useState(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualRu, setManualRu] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [grnBusy, setGrnBusy] = useState(false);
  const [postConfirmOpen, setPostConfirmOpen] = useState(false);
  const [postResult, setPostResult] = useState(null);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [reopenSelectedUnitIds, setReopenSelectedUnitIds] = useState([]);
  const [reopenBanner, setReopenBanner] = useState("");
  const [reopenBusy, setReopenBusy] = useState(false);
  const scanLockRef = useRef("");

  useEffect(() => {
    const asnId = String(searchParams.get("asnId") || "").trim();
    setSelectedId(asnId || null);
  }, [searchParams]);

  const listQ = useQuery({
    queryKey: ["incoming-asn", status, search],
    queryFn: () => apiGetWithQuery("/asn", incomingAsnListQuery({ status, search })),
  });

  const detailQ = useQuery({
    queryKey: ["asn", selectedId],
    queryFn: () => apiGet(`/asn/${selectedId}`),
    enabled: Boolean(selectedId),
  });

  const progressQ = useQuery({
    queryKey: ["receiving-progress", selectedId],
    queryFn: () => apiGet(`/receiving/asn/${selectedId}/progress`),
    enabled: Boolean(selectedId),
  });

  const settingsQ = useQuery({
    queryKey: ["receiving-settings"],
    queryFn: () => apiGet("/receiving/settings"),
    staleTime: 60_000,
  });

  const ruListQ = useQuery({
    queryKey: ["asn-receiving-units", selectedId],
    queryFn: () => apiGet(`/asn/${selectedId}/receiving-units`),
    enabled: Boolean(selectedId),
  });

  const items = listQ.data?.items || [];
  const detail = detailQ.data;
  const progress = progressQ.data?.progress;
  const session = progressQ.data?.session;
  const receivingUnits = progressQ.data?.receivingUnits || [];
  const draftGrn = progressQ.data?.draftGrn;
  const reopenReceiving = progressQ.data?.reopenReceiving;
  const draftStatus = String(draftGrn?.status || "").toUpperCase();
  const draftIsPosted = ["RECEIVED", "PARTIAL_RECEIVED", "POSTED", "CLOSED"].includes(draftStatus);
  const receivingComplete = String(session?.status || "").toUpperCase() === "COMPLETED";
  const canReopenReceiving =
    canReceive &&
    receivingComplete &&
    Boolean(draftGrn?.grnNo) &&
    draftStatus === "DRAFT" &&
    reopenReceiving?.eligible === true;
  const reopenableUnits = receivingUnits.filter(
    (r) => String(r.status || "").toUpperCase() === "COMPLETED" && r.receivingSessionUnitId,
  );
  const receivingTotals = receivingUnits.reduce(
    (acc, row) => ({
      accepted: acc.accepted + (Number(row.acceptedQty) || 0),
      damaged: acc.damaged + (Number(row.damagedQty) || 0),
      rejected: acc.rejected + (Number(row.rejectedQty) || 0),
      short: acc.short + (Number(row.shortQty) || 0),
      excess: acc.excess + (Number(row.excessQty) || 0),
    }),
    { accepted: 0, damaged: 0, rejected: 0, short: 0, excess: 0 }
  );
  const currentRus = ruListQ.data?.receivingUnits || [];
  const ruCount = currentRus.length;
  const printedCount = currentRus.filter((ru) => String(ru.status || "").toUpperCase() === "PRINTED").length;
  const plannedCount = currentRus.filter((ru) => String(ru.status || "").toUpperCase() === "PLANNED").length;
  const eligibleReceiveStatus = ["SHIPPED", "ARRIVED"].includes(String(detail?.status || "").toUpperCase());
  const canScanNow = canReceive && printedCount > 0 && !receivingComplete && !draftGrn?.grnNo;
  const receivingStarted =
    receivingComplete ||
    Boolean(draftGrn?.grnNo) ||
    (ruCount > 0 && ruListQ.data?.replanAllowed === false);
  const replanAllowed =
    canPrepareLabels &&
    eligibleReceiveStatus &&
    ruCount > 0 &&
    !receivingStarted &&
    ruListQ.data?.replanAllowed !== false;
  const reprintAllAllowed = canReprint && printedCount > 0 && eligibleReceiveStatus;

  function openPlanner(intent = "review") {
    setPlannerIntent(intent);
    setPlannerOpen(true);
  }

  async function confirmRePrepare() {
    const printed = printedCount > 0;
    const ok = await confirmDialog({
      title: "Re-Prepare Receiving Units",
      message: printed
        ? "Some RU labels have already been printed. Re-preparing will permanently supersede those RU numbers. Any old physical labels must be discarded and will no longer scan. Continue?"
        : "Re-prepare Receiving Units? The current RU plan will be superseded and a new plan will be created.",
    });
    if (ok) openPlanner("reprepare");
  }

  async function confirmReprintAll() {
    const ok = await confirmDialog({
      title: "Reprint All RU Labels",
      message: `Reprint all ${printedCount} active RU labels? This will print the same RU numbers again. Receiving quantities and RU identities will not change.`,
    });
    if (!ok || !detail?._id) return;
    try {
      const res = await apiPost(`/asn/${detail._id}/receiving-units/reprint-all`, {
        reason: "Replacement",
      });
      notify.success(`Queued ${res.count || res.jobs?.length || 0} reprint job(s)`);
      refreshReceiving();
    } catch (err) {
      notify.fromError(err, { fallback: "Could not reprint RU labels" });
    }
  }
  const canStartNow = canReceive && ruCount > 0 && eligibleReceiveStatus && !receivingComplete && !draftGrn?.grnNo;
  const canEnterRu = canReceive && ruCount > 0 && !receivingComplete && !draftGrn?.grnNo;

  function selectAsn(id) {
    navigate(incomingShipmentsPath(id), { replace: true });
  }

  function clearSelectedAsn() {
    navigate(incomingShipmentsPath(), { replace: true });
  }

  function refreshReceiving() {
    if (selectedId) {
      qc.invalidateQueries({ queryKey: ["receiving-progress", selectedId] });
      qc.invalidateQueries({ queryKey: ["asn-receiving-units", selectedId] });
      qc.invalidateQueries({ queryKey: ["incoming-asn"] });
    }
  }

  async function openScannedBarcode(barcode) {
    const value = String(barcode || "").trim().toUpperCase();
    if (!value) return;
    if (scanLockRef.current) return;
    scanLockRef.current = value;
    setScanError("");
    try {
      const data = await apiGet(`/receiving/scan/${encodeURIComponent(value)}`);
      if (!data.canReceive) {
        setScannerOpen(false);
        setScanError(data.message || "This barcode cannot be received.");
        return;
      }
      let sess = data.session;
      if (canReceive && !sess) {
        const started = await apiPost("/receiving/sessions", { asnId: data.ru.asnId });
        sess = started.session;
      }
      if (!sess) {
        setScanError("Could not open a receiving session.");
        return;
      }
      setScannerOpen(false);
      setSelectedId(String(data.ru.asnId));
      setInspect({ scan: { ...data, session: sess }, session: sess });
    } catch (err) {
      setScannerOpen(false);
      setScanError(err.message || "Barcode not found");
    } finally {
      scanLockRef.current = "";
    }
  }

  async function resumeReceiving() {
    if (!detail?._id) return;
    setScanError("");
    try {
      const started = await apiPost("/receiving/sessions", { asnId: detail._id });
      await qc.invalidateQueries({ queryKey: ["receiving-progress", detail._id] });
      setScannerOpen(true);
      return started;
    } catch (err) {
      setScanError(err.message || "Could not start receiving");
    }
  }

  async function generateDraftGrn() {
    if (!session?._id || grnBusy) return;
    setGrnBusy(true);
    setScanError("");
    try {
      await apiPost(`/receiving/sessions/${session._id}/grn`, {});
      refreshReceiving();
    } catch (err) {
      setScanError(err.message || "Could not generate Draft GRN");
    } finally {
      setGrnBusy(false);
    }
  }

  function reviewDraftGrn() {
    const grnNo = String(draftGrn?.grnNo || "").trim();
    if (!grnNo) return;
    navigate(`/store?tab=GRN&grnNo=${encodeURIComponent(grnNo)}`);
  }

  async function confirmPostDraftGrn() {
    const grnNo = String(draftGrn?.grnNo || "").trim();
    if (!grnNo || grnBusy) return;
    setGrnBusy(true);
    setScanError("");
    try {
      const data = await apiPost(`/grn/${encodeURIComponent(grnNo)}/post`, {});
      setPostResult(data);
      setPostConfirmOpen(false);
      refreshReceiving();
      if (selectedId) qc.invalidateQueries({ queryKey: ["asn", selectedId] });
    } catch (err) {
      setScanError(err.message || "Could not post GRN");
    } finally {
      setGrnBusy(false);
    }
  }

  async function confirmCompleteSession() {
    if (!session?._id) return;
    try {
      await apiPost(`/receiving/sessions/${session._id}/complete`);
      setReviewOpen(false);
      refreshReceiving();
    } catch (err) {
      setScanError(err.message || "Cannot complete receiving yet");
      setReviewOpen(false);
    }
  }

  async function confirmReopenReceiving() {
    if (!session?._id || reopenBusy) return;
    const reason = String(reopenReason || "").trim();
    if (!reason) {
      setScanError("Reason for reopening receiving is required");
      return;
    }
    const selectedIds = reopenSelectedUnitIds.filter(Boolean);
    if (!selectedIds.length) {
      setScanError("Select at least one Receiving Unit to reopen");
      return;
    }
    const ok = await confirmDialog({
      title: "Reopen receiving?",
      message:
        `Reopen ${selectedIds.length} selected Receiving Unit(s) for correction.\n\nThe current Draft GRN will be invalidated and a new Draft GRN must be generated after receiving is completed again.\n\nReceiving Unit numbers and printed barcode labels will NOT change.`,
      confirmLabel: "Reopen Receiving",
    });
    if (!ok) return;
    setReopenBusy(true);
    setScanError("");
    try {
      await apiPost(`/receiving/sessions/${session._id}/reopen`, {
        reason,
        receivingSessionUnitIds: selectedIds,
      });
      setReopenOpen(false);
      setReopenReason("");
      setReopenSelectedUnitIds([]);
      setReopenBanner("RECEIVING REOPENED FOR CORRECTION");
      notify.success("Receiving reopened for correction");
      refreshReceiving();
      if (selectedId) qc.invalidateQueries({ queryKey: ["asn-receiving-units", selectedId] });
    } catch (err) {
      setScanError(err.message || "Could not reopen receiving");
    } finally {
      setReopenBusy(false);
    }
  }

  function toggleReopenUnit(sessionUnitId) {
    const id = String(sessionUnitId || "");
    if (!id) return;
    setReopenSelectedUnitIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-white p-4">
        <h3 className="text-base font-semibold text-slate-800">Incoming shipments</h3>
        <p className="mt-1 text-sm text-slate-500">
          Warehouse receiving workspace. Prepare Receiving Units, print barcode labels, then scan and count. Stock is not
          posted until GRN is posted.
        </p>
        {listQ.isError ? (
          <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{listQ.error?.message || "Could not load shipments"}</p>
        ) : null}
        {scanError ? <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{scanError}</p> : null}
        {reopenBanner ? (
          <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-950">
            {reopenBanner}
          </p>
        ) : null}
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input
            className="min-h-12 rounded-xl border border-slate-200 px-3 py-2 text-base"
            placeholder="ASN number"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="min-h-12 rounded-xl border border-slate-200 bg-white px-3 py-2 text-base"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="incoming">Shipped & arrived</option>
            <option value="SHIPPED">Shipped</option>
            <option value="ARRIVED">Arrived</option>
          </select>
        </div>
      </div>

      <div className="space-y-3 md:hidden">
        {items.map((row) => (
          <button
            key={row._id}
            type="button"
            className="w-full rounded-2xl border bg-white p-4 text-left"
            onClick={() => selectAsn(row._id)}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-lg font-semibold text-sky-800">{row.asnNo}</span>
              <AsnStatusBadge status={row.status} />
            </div>
            <div className="mt-2 text-sm text-slate-700">{row.supplierName || "—"}</div>
            <div className="mt-1 font-mono text-sm">{row.sourcePoNo || "—"}</div>
            <div className="mt-1 text-sm text-slate-500">ETA {formatAsnDate(row.expectedArrivalDate)}</div>
          </button>
        ))}
        {!items.length ? (
          <div className="py-8 text-center text-slate-500">
            <p className="font-medium text-slate-700">No shipments ready for receiving.</p>
            <p className="mt-1 text-sm">SHIPPED and ARRIVED ASNs will appear here.</p>
            {canOpenAsnRegister ? (
              <button
                type="button"
                className="mt-3 min-h-11 rounded-xl border px-4 text-sm font-semibold"
                onClick={() => navigate("/asn")}
              >
                Open ASN Register
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="hidden overflow-x-auto rounded-2xl border bg-white md:block">
        <table className="min-w-[720px] w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-3">ASN</th>
              <th className="px-3 py-3">Supplier</th>
              <th className="px-3 py-3">PO</th>
              <th className="px-3 py-3">AWB / BL / Tracking</th>
              <th className="px-3 py-3">Packages</th>
              <th className="px-3 py-3">ETA</th>
              <th className="px-3 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row._id} className="border-t border-slate-100">
                <td className="px-3 py-3">
                  <button
                    type="button"
                    className="min-h-11 font-mono font-semibold text-sky-800"
                    onClick={() => selectAsn(row._id)}
                  >
                    {row.asnNo}
                  </button>
                </td>
                <td className="px-3 py-3">{row.supplierName || "—"}</td>
                <td className="px-3 py-3 font-mono">{row.sourcePoNo || "—"}</td>
                <td className="px-3 py-3">{trackingDisplay(row)}</td>
                <td className="px-3 py-3">{row.numberOfPackages || "—"}</td>
                <td className="px-3 py-3">{formatAsnDate(row.expectedArrivalDate)}</td>
                <td className="px-3 py-3"><AsnStatusBadge status={row.status} /></td>
              </tr>
            ))}
            {!items.length ? (
              <tr>
                <td className="px-3 py-8 text-center text-slate-500" colSpan={7}>
                  <div>No shipments ready for receiving.</div>
                  <div className="mt-1 text-xs">SHIPPED and ARRIVED ASNs will appear here.</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {selectedId ? (
        <div className="space-y-4 rounded-2xl border bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-lg font-bold text-slate-900">{detail?.asnNo || "Shipment"}</h3>
            <button type="button" className="min-h-11 rounded-xl border px-3 text-sm font-semibold" onClick={clearSelectedAsn}>
              Back to Incoming Shipments
            </button>
          </div>
        {!detail ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <AsnStatusBadge status={detail.status} />
              <span>{detail.supplierName}</span>
              <span className="font-mono">{detail.sourcePoNo}</span>
            </div>
            {eligibleReceiveStatus && !receivingComplete && !draftGrn?.grnNo ? (
              <div className="grid gap-2">
                {ruCount === 0 ? (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                    <div className="text-lg font-bold text-amber-950">Receiving Units have not been prepared.</div>
                    <p className="mt-2 text-sm text-amber-900">
                      Create Receiving Units and print barcode labels before starting physical inspection.
                    </p>
                    {canPrepareLabels ? (
                      <button
                        type="button"
                        className="mt-3 min-h-14 w-full rounded-2xl bg-slate-900 px-4 text-base font-semibold text-white"
                        onClick={() => openPlanner("prepare")}
                      >
                        Prepare Receiving Units
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {ruCount > 0 && printedCount === 0 && plannedCount > 0 ? (
                  <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950">
                    Labels are not printed yet. Print RU Labels before scanning. Unprinted (PLANNED) barcodes cannot be received.
                  </p>
                ) : null}
                {canScanNow ? (
                  <button
                    type="button"
                    className="min-h-16 w-full rounded-2xl bg-sky-700 px-4 text-xl font-bold text-white"
                    onClick={() => setScannerOpen(true)}
                  >
                    Scan Item
                  </button>
                ) : null}
                {canEnterRu ? (
                  <button
                    type="button"
                    className="min-h-12 w-full rounded-2xl border text-base font-semibold"
                    onClick={() => {
                      setScanError("");
                      setManualOpen(true);
                    }}
                  >
                    Enter RU Number
                  </button>
                ) : null}
                {canStartNow && (session || printedCount > 0) ? (
                  <button
                    type="button"
                    className="min-h-14 w-full rounded-2xl bg-slate-900 px-4 text-base font-semibold text-white"
                    onClick={resumeReceiving}
                  >
                    {session ? "Resume Receiving" : "Start Receiving"}
                  </button>
                ) : null}
                {progress?.ruPending === 0 && progress?.ruTotal > 0 && session?.status !== "COMPLETED" ? (
                  <button
                    type="button"
                    className="min-h-12 w-full rounded-2xl border text-base font-semibold"
                    onClick={() => setReviewOpen(true)}
                  >
                    Complete Receiving
                  </button>
                ) : null}
              </div>
            ) : null}
            {receivingComplete ? (
              <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-4">
                <div className="text-xl font-bold text-emerald-900">Receiving Complete</div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-lg">
                  <div>Accepted {receivingTotals.accepted}</div>
                  <div>Damaged {receivingTotals.damaged}</div>
                  <div>Rejected {receivingTotals.rejected}</div>
                  <div>Short {receivingTotals.short}</div>
                  <div className="col-span-2">Excess {receivingTotals.excess}</div>
                </div>
                {draftGrn?.grnNo ? (
                  <>
                    {draftIsPosted || postResult ? (
                      <div className="mt-3 rounded-xl bg-white p-3 text-emerald-950">
                        <div className="text-lg font-bold">GRN Posted Successfully</div>
                        <div className="mt-1 font-mono text-xl">{postResult?.grnNo || draftGrn.grnNo}</div>
                        <div className="mt-2 text-base">
                          Accepted to stock {postResult?.acceptedToStock ?? draftGrn.totals?.grnEligibleQty ?? "—"}
                        </div>
                        <div className="mt-1 text-sm">ASN {postResult?.asnStatus || detail.status}</div>
                        <button
                          type="button"
                          className="mt-3 min-h-14 w-full rounded-2xl bg-sky-700 text-lg font-bold text-white"
                          onClick={reviewDraftGrn}
                        >
                          View GRN
                        </button>
                        <button
                          type="button"
                          className="mt-2 min-h-12 w-full rounded-2xl border text-base font-semibold"
                          onClick={clearSelectedAsn}
                        >
                          Back to Incoming Shipments
                        </button>
                      </div>
                    ) : (
                      <>
                    <div className="mt-4 text-xl font-bold text-slate-900">Draft GRN Created</div>
                    <div className="mt-1 font-mono text-2xl font-bold text-sky-800">{draftGrn.grnNo}</div>
                    {Number(draftGrn.totals?.excessPendingQty) > 0 ? (
                      <p className="mt-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">
                        GRN eligible {draftGrn.totals.grnEligibleQty}. Extra physical qty{" "}
                        {draftGrn.totals.excessPendingQty} is receiving evidence only and is not commercially received
                        on this GRN. A later commercial document would be required to admit it.
                      </p>
                    ) : null}
                    {draftGrn.entitlementReview?.entitlementValid === false ? (
                      <p className="mt-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">
                        PO entitlement changed (shortfall {draftGrn.entitlementReview.entitlementShortfall}). Posting is
                        blocked until the draft is deleted and regenerated.
                      </p>
                    ) : null}
                    {draftGrn.postReadiness && draftGrn.postReadiness.postReady === false ? (
                      <div className="mt-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">
                        <div className="font-semibold">
                          GRN NOT READY TO POST — {draftGrn.postReadiness.blockers?.length || 0} required item
                          {(draftGrn.postReadiness.blockers?.length || 0) === 1 ? "" : "s"} remaining
                        </div>
                        <ul className="mt-2 list-disc space-y-1 pl-5">
                          {(draftGrn.postReadiness.blockers || []).slice(0, 8).map((b) => (
                            <li key={`${b.code}-${b.message}`}>{b.message}</li>
                          ))}
                        </ul>
                      </div>
                    ) : draftGrn.postReadiness?.postReady ? (
                      <p className="mt-2 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-900">
                        ✓ READY TO POST
                      </p>
                    ) : null}
                    <button
                      type="button"
                      className="mt-3 min-h-16 w-full rounded-2xl bg-sky-700 text-xl font-bold text-white"
                      onClick={reviewDraftGrn}
                    >
                      {draftGrn.postReadiness?.postReady === false
                        ? "Complete / Review Draft GRN"
                        : "Review Draft GRN"}
                    </button>
                    {canPostGrn &&
                    draftGrn.entitlementReview?.entitlementValid !== false &&
                    draftGrn.postReadiness?.postReady === true ? (
                      <button
                        type="button"
                        className="mt-2 min-h-16 w-full rounded-2xl bg-emerald-700 text-xl font-bold text-white"
                        onClick={() => setPostConfirmOpen(true)}
                        disabled={grnBusy}
                      >
                        POST GRN
                      </button>
                    ) : canPostGrn && draftGrn.entitlementReview?.entitlementValid !== false ? (
                      <button
                        type="button"
                        className="mt-2 min-h-16 w-full rounded-2xl bg-slate-300 text-xl font-bold text-slate-600"
                        disabled
                        title="Complete Draft GRN customs and receiving requirements first"
                      >
                        POST GRN
                      </button>
                    ) : null}
                    {canReceive ? (
                      <button
                        type="button"
                        className="mt-2 min-h-12 w-full rounded-2xl border text-base font-semibold"
                        onClick={generateDraftGrn}
                        disabled={grnBusy}
                      >
                        Open existing Draft GRN
                      </button>
                    ) : null}
                    {canReopenReceiving ? (
                      <button
                        type="button"
                        className="mt-2 min-h-12 w-full rounded-2xl border border-amber-400 bg-amber-50 text-base font-semibold text-amber-950"
                        onClick={() => {
                          setReopenReason("");
                          setReopenSelectedUnitIds([]);
                          setReopenOpen(true);
                        }}
                        disabled={reopenBusy || grnBusy}
                      >
                        Reopen Receiving
                      </button>
                    ) : null}
                      </>
                    )}
                  </>
                ) : canReceive ? (
                  <button
                    type="button"
                    className="mt-4 min-h-16 w-full rounded-2xl bg-sky-700 text-xl font-bold text-white"
                    onClick={generateDraftGrn}
                    disabled={grnBusy}
                  >
                    {grnBusy ? "Generating…" : "Generate Draft GRN"}
                  </button>
                ) : null}
              </div>
            ) : null}
            {progress || ruCount > 0 ? (
              <div className="rounded-2xl border bg-slate-50 p-4">
                <div className="font-semibold">{detail.asnNo}</div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-base">
                  <div>Receiving Units: {ruCount || progress?.ruTotal || 0}</div>
                  <div>Printed: {printedCount} / {ruCount || progress?.ruTotal || 0}</div>
                  <div>Photos: {progress?.photos || 0}</div>
                  <div>Completed {progress?.ruCompleted || 0}</div>
                  <div>In Progress {progress?.ruInProgress || 0}</div>
                  <div>Pending {progress?.ruPending || 0}</div>
                  <div>Accepted {receivingTotals.accepted}</div>
                  <div>Damaged {receivingTotals.damaged}</div>
                  <div>Rejected {receivingTotals.rejected}</div>
                  <div>Short {receivingTotals.short}</div>
                  <div className="col-span-2">Excess {receivingTotals.excess}</div>
                  {!progress?.mixedUom ? (
                    <>
                      <div>Planned Qty {progress?.plannedQty}</div>
                      <div>Counted Qty {progress?.countedQty}</div>
                    </>
                  ) : (
                    <div className="col-span-2 text-slate-600">Quantities shown per article (mixed UOM)</div>
                  )}
                </div>
                <div className="mt-3 space-y-2">
                  {(progress?.articles || []).map((row) => (
                    <div key={`${row.article}-${row.uom}`} className="rounded-xl bg-white p-3">
                      <div className="font-mono font-bold">
                        {row.article} — {row.description || ""}
                      </div>
                      <div>
                        {row.ruCompleted} / {row.ruTotal} RUs completed
                      </div>
                      <div>
                        {row.countedQty} / {row.plannedQty} {row.uom} counted
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {canPrepareLabels && eligibleReceiveStatus ? (
              <div className="grid gap-2">
                <button
                  type="button"
                  className="min-h-14 w-full rounded-2xl bg-slate-900 px-4 text-base font-semibold text-white"
                  onClick={() => openPlanner(ruCount === 0 ? "prepare" : "review")}
                >
                  {ruCount === 0 ? "Prepare Receiving Units" : "Review Receiving Units"}
                </button>
                {ruCount > 0 ? (
                  <button
                    type="button"
                    className="min-h-14 w-full rounded-2xl bg-sky-800 px-4 text-base font-semibold text-white"
                    onClick={() => openPlanner("print")}
                  >
                    Print RU Labels
                  </button>
                ) : null}
                {replanAllowed ? (
                  <button
                    type="button"
                    className="min-h-14 w-full rounded-2xl border border-amber-300 bg-amber-50 px-4 text-base font-semibold text-amber-950"
                    onClick={confirmRePrepare}
                  >
                    Re-Prepare Receiving Units
                  </button>
                ) : null}
                {ruCount > 0 && receivingStarted ? (
                  <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
                    Receiving has started. RU structure can no longer be changed.
                  </p>
                ) : null}
                {reprintAllAllowed ? (
                  <button
                    type="button"
                    className="min-h-14 w-full rounded-2xl border px-4 text-base font-semibold"
                    onClick={confirmReprintAll}
                  >
                    Reprint All RU Labels
                  </button>
                ) : null}
                <button
                  type="button"
                  className="min-h-12 w-full rounded-2xl border text-base font-semibold"
                  onClick={() => navigate(`/store?tab=${encodeURIComponent("Label Queue")}`)}
                >
                  View Label Queue
                </button>
              </div>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2 text-sm">
              <div>Mode: {detail.shipmentMode || "—"}</div>
              <div>AWB: {detail.awbNumber || "—"}</div>
              <div>BL: {detail.blNumber || "—"}</div>
              <div>Tracking: {detail.trackingNumber || "—"}</div>
              <div>Packages: {detail.numberOfPackages || "—"}</div>
              <div>ETA: {formatAsnDate(detail.expectedArrivalDate)}</div>
            </div>
            <div className="space-y-2">
              {(detail.lines || []).map((line) => (
                <div key={String(line._id || line.poLineId)} className="rounded-xl border p-3">
                  <div className="font-mono text-base font-bold">{line.article}</div>
                  <div className="text-sm text-slate-600">{line.description || line.itemName}</div>
                  <div className="mt-1 text-sm font-semibold">
                    {line.asnQty} {line.uom}
                  </div>
                </div>
              ))}
            </div>
            <div>
              <div className="mb-1 font-semibold">Documents</div>
              <ul className="space-y-1 text-sm">
                {(detail.attachments || []).map((att) => (
                  <li key={att._id}>
                    {att.documentId ? (
                      <button
                        type="button"
                        className="min-h-11 text-sky-800"
                        onClick={async () => {
                          const data = await apiGet(`/documents/${att.documentId}/download`);
                          const url = data?.url || data?.fileUrl;
                          if (url) window.open(url, "_blank", "noopener,noreferrer");
                        }}
                      >
                        {att.originalFilename || att.documentType}
                      </button>
                    ) : (
                      <span>{att.originalFilename || att.documentType}</span>
                    )}
                  </li>
                ))}
                {!(detail.attachments || []).length ? <li className="text-gray-500">No documents</li> : null}
              </ul>
            </div>
            <p className="text-xs text-slate-500">
              Physical receiving does not post stock. After a Draft GRN is reviewed, POST GRN creates stock and closes the ASN shipment.
            </p>
          </div>
        )}
        </div>
      ) : null}

      <Modal
        open={postConfirmOpen}
        onClose={() => setPostConfirmOpen(false)}
        title="Confirm POST GRN"
      >
        <div className="space-y-3 text-base">
          <div>GRN <span className="font-mono font-bold">{draftGrn?.grnNo || "—"}</span></div>
          <div>ASN <span className="font-mono font-bold">{detail?.asnNo || draftGrn?.asnNo || "—"}</span></div>
          <div>PO <span className="font-mono font-bold">{detail?.sourcePoNo || draftGrn?.poNo || "—"}</span></div>
          <div>Accepted to stock {draftGrn?.totals?.grnEligibleQty ?? receivingTotals.accepted}</div>
          <div>Damaged {receivingTotals.damaged} · Rejected {receivingTotals.rejected} · Short {receivingTotals.short}</div>
          <div>Extra physical qty (evidence only) {draftGrn?.totals?.excessPendingQty ?? receivingTotals.excess}</div>
          <div>Warehouse {(draftGrn?.items || [])[0]?.warehouse || "MAIN"}</div>
          <div>Putaway {(draftGrn?.items || [])[0]?.location || "—"}</div>
          <p className="text-sm text-slate-600">RU labels already printed will not be reprinted.</p>
          <button
            type="button"
            className="min-h-16 w-full rounded-2xl bg-emerald-700 text-xl font-bold text-white"
            onClick={confirmPostDraftGrn}
            disabled={grnBusy}
          >
            {grnBusy ? "Posting…" : "Confirm POST GRN"}
          </button>
          <button
            type="button"
            className="min-h-12 w-full rounded-2xl border text-base font-semibold"
            onClick={() => setPostConfirmOpen(false)}
          >
            Cancel
          </button>
        </div>
      </Modal>

      <Modal
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        title="Enter RU Number"
      >
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setManualOpen(false);
            openScannedBarcode(manualRu);
          }}
        >
          <input
            className="min-h-14 w-full rounded-xl border px-3 text-lg uppercase"
            value={manualRu}
            onChange={(e) => setManualRu(e.target.value.toUpperCase())}
            placeholder="MAR-RU-000125"
            autoCapitalize="characters"
          />
          <button type="submit" className="min-h-14 w-full rounded-2xl bg-sky-700 text-lg font-semibold text-white">
            Lookup
          </button>
        </form>
      </Modal>

      <Modal
        open={reopenOpen}
        onClose={() => !reopenBusy && setReopenOpen(false)}
        title="Reopen Receiving"
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Select the Receiving Unit(s) needing correction. The current Draft GRN will be invalidated. RU numbers and
            barcodes will not change.
          </p>
          <div className="max-h-64 space-y-2 overflow-y-auto rounded-xl border p-2">
            {reopenableUnits.length === 0 ? (
              <p className="p-2 text-sm text-slate-500">No completed Receiving Units available to reopen.</p>
            ) : (
              reopenableUnits.map((ru) => {
                const sid = String(ru.receivingSessionUnitId);
                const weight =
                  ru.actualUnitWeightKg != null && Number(ru.actualUnitWeightKg) > 0
                    ? `${Number(ru.actualUnitWeightKg)} kg`
                    : "—";
                return (
                  <label
                    key={sid}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-2 hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={reopenSelectedUnitIds.includes(sid)}
                      disabled={reopenBusy}
                      onChange={() => toggleReopenUnit(sid)}
                    />
                    <span className="text-sm">
                      <span className="font-mono font-semibold">{ru.ruNo}</span>
                      <span className="text-slate-600">
                        {" "}
                        — {ru.article || "—"} — Qty {ru.acceptedQty ?? ru.actualQty ?? "—"} — Weight {weight}
                      </span>
                    </span>
                  </label>
                );
              })
            )}
          </div>
          <label className="block text-sm font-semibold text-slate-700">
            Reason for reopening receiving *
            <textarea
              className="mt-1 min-h-24 w-full rounded-xl border px-3 py-2 text-sm"
              value={reopenReason}
              disabled={reopenBusy}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="e.g. Missing actual unit weight"
            />
          </label>
          <button
            type="button"
            className="min-h-14 w-full rounded-2xl border border-amber-500 bg-amber-600 text-lg font-semibold text-white disabled:opacity-40"
            disabled={
              reopenBusy ||
              !String(reopenReason || "").trim() ||
              reopenSelectedUnitIds.length === 0
            }
            onClick={confirmReopenReceiving}
          >
            {reopenBusy ? "Reopening…" : "Confirm Reopen Receiving"}
          </button>
        </div>
      </Modal>

      <AsnReceivingLabelPlanner
        asn={detail}
        open={plannerOpen && !!detail}
        intent={plannerIntent}
        onClose={() => {
          setPlannerOpen(false);
          setPlannerIntent("review");
        }}
        canPrint={canPrepareLabels}
        canReprint={canReprint}
      />

      <ReceivingBarcodeScanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={openScannedBarcode}
      />

      <ReceivingDispositionReview
        open={reviewOpen}
        rows={receivingUnits}
        onClose={() => setReviewOpen(false)}
        onConfirm={confirmCompleteSession}
      />

      <ReceivingUnitInspectScreen
        open={!!inspect}
        scan={inspect?.scan}
        session={inspect?.session}
        settings={settingsQ.data}
        onClose={() => setInspect(null)}
        onChanged={refreshReceiving}
        onScanNext={() => {
          setInspect(null);
          setScannerOpen(true);
        }}
      />
    </div>
  );
}
