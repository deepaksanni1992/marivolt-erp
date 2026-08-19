/**
 * Derived operational progress. Does not persist extra ASN statuses.
 */
export default function AsnWorkflowStrip({ asnStatus, sessionStatus, grnStatus } = {}) {
  const asn = String(asnStatus || "").toUpperCase();
  const session = String(sessionStatus || "").toUpperCase();
  const grn = String(grnStatus || "").toUpperCase();
  const steps = [
    { id: "CREATED", label: "ASN created", on: Boolean(asn) && asn !== "CANCELLED" },
    { id: "SHIPPED", label: "Shipped", on: ["SHIPPED", "ARRIVED", "PARTIALLY_RECEIVED", "COMPLETED"].includes(asn) },
    { id: "ARRIVED", label: "Arrived", on: ["ARRIVED", "PARTIALLY_RECEIVED", "COMPLETED"].includes(asn) },
    { id: "RECEIVING", label: "Receiving", on: Boolean(session) && session !== "CANCELLED" },
    { id: "RECEIVING_COMPLETE", label: "Receiving complete", on: session === "COMPLETED" },
    { id: "GRN_DRAFT", label: "GRN draft", on: grn === "DRAFT" || ["RECEIVED", "PARTIAL_RECEIVED", "POSTED", "CLOSED"].includes(grn) },
    { id: "GRN_POSTED", label: "GRN posted", on: ["RECEIVED", "PARTIAL_RECEIVED", "POSTED", "CLOSED"].includes(grn) },
  ];
  return (
    <ol className="flex flex-wrap gap-2 text-[11px]">
      {steps.map((step) => (
        <li
          key={step.id}
          className={`rounded-full px-2.5 py-1 ring-1 ${
            step.on ? "bg-sky-50 text-sky-900 ring-sky-200" : "bg-slate-50 text-slate-400 ring-slate-200"
          }`}
        >
          {step.label}
        </li>
      ))}
    </ol>
  );
}
