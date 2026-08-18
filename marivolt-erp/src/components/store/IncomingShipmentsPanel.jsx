import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Modal from "../erp/Modal.jsx";
import AsnReceivingLabelPlanner from "./AsnReceivingLabelPlanner.jsx";
import { apiGet, apiGetWithQuery } from "../../lib/api.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { AsnStatusBadge, formatAsnDate, trackingDisplay } from "../../lib/asnUi.js";

export default function IncomingShipmentsPanel() {
  const { can } = useAuth();
  const canPrepareLabels = can("ASN", "view") && can("LABELS", "print");
  const canReprint = can("LABELS", "reprint");
  const [status, setStatus] = useState("SHIPPED,ARRIVED");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [plannerOpen, setPlannerOpen] = useState(false);

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

  const items = listQ.data?.items || [];
  const detail = detailQ.data;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-white p-4">
        <h3 className="text-base font-semibold text-slate-800">Incoming shipments</h3>
        <p className="mt-1 text-sm text-slate-500">
          View-only ASN register for warehouse receiving. Prepare labels here. Stock is not posted from this screen.
        </p>
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
            <p className="text-xs text-slate-500">Store operators can prepare labels without editing shipment details.</p>
          </div>
        )}
      </Modal>

      <AsnReceivingLabelPlanner
        asn={detail}
        open={plannerOpen && !!detail}
        onClose={() => setPlannerOpen(false)}
        canPrint={canPrepareLabels}
        canReprint={canReprint}
      />
    </div>
  );
}
