import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Modal from "../erp/Modal.jsx";
import AsnReceivingLabelPlanner from "./AsnReceivingLabelPlanner.jsx";
import ReceivingBarcodeScanner from "./ReceivingBarcodeScanner.jsx";
import ReceivingDispositionReview from "./ReceivingDispositionReview.jsx";
import ReceivingUnitInspectScreen from "./ReceivingUnitInspectScreen.jsx";
import { apiGet, apiGetWithQuery, apiPost } from "../../lib/api.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { AsnStatusBadge, formatAsnDate, trackingDisplay } from "../../lib/asnUi.js";

export default function IncomingShipmentsPanel() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const canPrepareLabels = can("ASN", "view") && can("LABELS", "print");
  const canReprint = can("LABELS", "reprint");
  const canReceive = can("ASN", "view") && can("STORE", "create");
  const [status, setStatus] = useState("SHIPPED,ARRIVED");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanError, setScanError] = useState("");
  const [inspect, setInspect] = useState(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualRu, setManualRu] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [grnBusy, setGrnBusy] = useState(false);
  const scanLockRef = useRef("");

  useEffect(() => {
    const asnId = String(searchParams.get("asnId") || "").trim();
    if (asnId) setSelectedId(asnId);
  }, [searchParams]);

  const listQ = useQuery({
    queryKey: ["incoming-asn", status, search],
    queryFn: () =>
      apiGetWithQuery("/asn", {
        incoming: status ? undefined : "1",
        status: status || undefined,
        asnNo: search || undefined,
        limit: 50,
        page: 1,
      }),
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

  const items = listQ.data?.items || [];
  const detail = detailQ.data;
  const progress = progressQ.data?.progress;
  const session = progressQ.data?.session;
  const receivingUnits = progressQ.data?.receivingUnits || [];
  const draftGrn = progressQ.data?.draftGrn;
  const receivingComplete = String(session?.status || "").toUpperCase() === "COMPLETED";
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

  function refreshReceiving() {
    if (selectedId) qc.invalidateQueries({ queryKey: ["receiving-progress", selectedId] });
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

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-white p-4">
        <h3 className="text-base font-semibold text-slate-800">Incoming shipments</h3>
        <p className="mt-1 text-sm text-slate-500">
          Scan a Receiving Unit label, count, photograph, and save a draft. Stock is not posted from this screen.
        </p>
        {canReceive ? (
          <button
            type="button"
            className="mt-4 min-h-16 w-full rounded-2xl bg-sky-700 text-2xl font-bold text-white"
            onClick={() => {
              setScanError("");
              setScannerOpen(true);
            }}
          >
            Scan Item
          </button>
        ) : null}
        <button
          type="button"
          className="mt-2 min-h-12 w-full rounded-2xl border text-base font-semibold"
          onClick={() => {
            setScanError("");
            setManualOpen(true);
          }}
        >
          Enter RU Number
        </button>
        {scanError ? <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{scanError}</p> : null}
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
            <option value="SHIPPED,ARRIVED">Shipped & arrived</option>
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
            onClick={() => setSelectedId(row._id)}
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
        {!items.length ? <p className="py-8 text-center text-slate-500">No incoming shipments</p> : null}
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
                    onClick={() => setSelectedId(row._id)}
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
                <td className="px-3 py-8 text-center text-slate-500" colSpan={7}>No incoming shipments</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Modal open={!!selectedId} onClose={() => setSelectedId(null)} title={detail?.asnNo || "ASN"} document>
        {!detail ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <AsnStatusBadge status={detail.status} />
              <span>{detail.supplierName}</span>
              <span className="font-mono">{detail.sourcePoNo}</span>
            </div>
            {canReceive && ["SHIPPED", "ARRIVED"].includes(String(detail.status || "").toUpperCase()) && !receivingComplete ? (
              <div className="grid gap-2">
                <button
                  type="button"
                  className="min-h-16 w-full rounded-2xl bg-sky-700 px-4 text-xl font-bold text-white"
                  onClick={() => setScannerOpen(true)}
                >
                  Scan Item
                </button>
                <button
                  type="button"
                  className="min-h-14 w-full rounded-2xl bg-slate-900 px-4 text-base font-semibold text-white"
                  onClick={resumeReceiving}
                >
                  {session ? "Resume Receiving" : "Start Receiving"}
                </button>
                {progress?.ruPending === 0 && progress?.ruTotal > 0 && session?.status !== "COMPLETED" ? (
                  <button
                    type="button"
                    className="min-h-12 w-full rounded-2xl border text-base font-semibold"
                    onClick={() => setReviewOpen(true)}
                  >
                    Complete Receiving Session
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
                    <div className="mt-4 text-xl font-bold text-slate-900">Draft GRN Created</div>
                    <div className="mt-1 font-mono text-2xl font-bold text-sky-800">{draftGrn.grnNo}</div>
                    {Number(draftGrn.totals?.excessPendingQty) > 0 ? (
                      <p className="mt-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">
                        GRN eligible {draftGrn.totals.grnEligibleQty}. Excess pending {draftGrn.totals.excessPendingQty}{" "}
                        requires Purchase/Admin resolution. Store cannot approve over-receipt.
                      </p>
                    ) : null}
                    <button
                      type="button"
                      className="mt-3 min-h-16 w-full rounded-2xl bg-sky-700 text-xl font-bold text-white"
                      onClick={reviewDraftGrn}
                    >
                      Review Draft GRN
                    </button>
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
            {progress ? (
              <div className="rounded-2xl border bg-slate-50 p-4">
                <div className="font-semibold">{detail.asnNo}</div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-base">
                  <div>Receiving Units: {progress.ruTotal}</div>
                  <div>Photos: {progress.photos}</div>
                  <div>Completed {progress.ruCompleted}</div>
                  <div>In Progress {progress.ruInProgress}</div>
                  <div>Pending {progress.ruPending}</div>
                  {!progress.mixedUom ? (
                    <>
                      <div>Planned Qty {progress.plannedQty}</div>
                      <div>Counted Qty {progress.countedQty}</div>
                    </>
                  ) : (
                    <div className="col-span-2 text-slate-600">Quantities shown per article (mixed UOM)</div>
                  )}
                </div>
                <div className="mt-3 space-y-2">
                  {(progress.articles || []).map((row) => (
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
            {canPrepareLabels && ["SHIPPED", "ARRIVED"].includes(String(detail.status || "").toUpperCase()) ? (
              <button
                type="button"
                className="min-h-14 w-full rounded-2xl bg-slate-900 px-4 text-base font-semibold text-white"
                onClick={() => setPlannerOpen(true)}
              >
                Prepare Labels
              </button>
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
              Physical receiving does not post stock. Generate a Draft GRN after receiving is complete; posting is a later step.
            </p>
          </div>
        )}
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

      <AsnReceivingLabelPlanner
        asn={detail}
        open={plannerOpen && !!detail}
        onClose={() => setPlannerOpen(false)}
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
