import { FormField, TextInput } from "../erp/FormField.jsx";
import { resolvePiPaymentRequest } from "../../lib/piPaymentRequest.js";

const textareaClass =
  "w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900 disabled:bg-gray-50";

/**
 * PI Payment Request controls + commercial / payable totals summary.
 */
export default function ProformaPaymentRequestPanel({
  values = {},
  totals = {},
  commercialGrandTotal = 0,
  currency = "",
  money,
  disabled = false,
  onChange,
  remainingEligible = null,
}) {
  const live = resolvePiPaymentRequest(values, commercialGrandTotal || totals.grandTotal);
  const set = (patch) => {
    if (disabled || typeof onChange !== "function") return;
    onChange(patch);
  };

  return (
    <div className="mt-3 space-y-3">
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Payment Request</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="PI Value Type">
            <select
              className="w-full rounded-xl border px-3 py-2 text-sm disabled:bg-gray-50"
              disabled={disabled}
              value={live.piValueType || "FULL"}
              onChange={(e) => {
                const piValueType = e.target.value;
                const next = { ...values, piValueType };
                if (piValueType === "FULL") {
                  next.advancePercentage = "";
                  next.requestedAmount = "";
                } else if (piValueType === "PERCENTAGE" && !next.advancePercentage) {
                  next.advancePercentage = 30;
                }
                set(next);
              }}
            >
              <option value="FULL">Full Value</option>
              <option value="PERCENTAGE">Percentage of Total</option>
              <option value="FIXED_AMOUNT">Fixed Amount</option>
            </select>
          </FormField>
          {live.piValueType === "PERCENTAGE" ? (
            <FormField label="Advance Percentage">
              <TextInput
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                disabled={disabled}
                value={values.advancePercentage ?? live.advancePercentage ?? ""}
                onChange={(e) => set({ ...values, piValueType: "PERCENTAGE", advancePercentage: e.target.value })}
                placeholder="e.g. 30"
              />
            </FormField>
          ) : null}
          {live.piValueType === "FIXED_AMOUNT" ? (
            <FormField label="Requested Amount">
              <TextInput
                type="number"
                min="0.01"
                step="0.01"
                disabled={disabled}
                value={values.requestedAmount ?? live.requestedAmount ?? ""}
                onChange={(e) => set({ ...values, piValueType: "FIXED_AMOUNT", requestedAmount: e.target.value })}
              />
            </FormField>
          ) : (
            <FormField label="Requested Amount (auto)">
              <TextInput value={money(live.requestedAmount)} disabled readOnly />
            </FormField>
          )}
        </div>
        <FormField label="Advance Remarks" className="mt-3">
          <textarea
            rows={3}
            className={textareaClass}
            disabled={disabled}
            value={values.advanceRemarks || ""}
            onChange={(e) => set({ ...values, advanceRemarks: e.target.value })}
            placeholder={
              "e.g.\n30% advance payment against Order Acknowledgement.\nBalance 70% payable before dispatch."
            }
          />
        </FormField>
        {remainingEligible != null && Number.isFinite(Number(remainingEligible)) ? (
          <p className="mt-2 text-xs text-slate-600">
            Remaining PI-eligible on linked OA: {money(remainingEligible)} {currency || ""}
          </p>
        ) : null}
      </div>

      <div className="ml-auto w-full max-w-md rounded-xl border bg-white p-3">
        <div className="flex justify-between py-1">
          <span>Subtotal</span>
          <span>{money(totals.subTotal)}</span>
        </div>
        <div className="flex justify-between py-1">
          <span>Packing Cost</span>
          <span>{money(totals.packingCost)}</span>
        </div>
        <div className="flex justify-between py-1">
          <span>Clearance Cost</span>
          <span>{money(totals.clearanceCost)}</span>
        </div>
        <div className="flex justify-between py-1">
          <span>Discount</span>
          <span>{money(totals.discountTotal)}</span>
        </div>
        <div className="flex justify-between py-1">
          <span>Tax</span>
          <span>{money(totals.taxTotal)}</span>
        </div>
        <div className="flex justify-between py-1 font-medium">
          <span>Commercial Grand Total</span>
          <span>
            {money(live.commercialGrandTotal)} {currency || ""}
          </span>
        </div>
        <div className="my-2 border-t border-dashed border-slate-200" />
        {live.piValueType === "PERCENTAGE" && live.advancePercentage != null ? (
          <div className="flex justify-between py-1 text-sm">
            <span>Advance Percentage</span>
            <span>{live.advancePercentage}%</span>
          </div>
        ) : null}
        <div className="flex justify-between gap-3 py-1 text-base font-bold text-gray-900">
          <span>Amount Payable / Requested PI Amount</span>
          <span className="whitespace-nowrap">
            {money(live.requestedAmount)} {currency || ""}
          </span>
        </div>
        <div className="flex justify-between py-1 text-sm">
          <span>Balance Amount</span>
          <span>
            {money(live.commercialBalanceAmount)} {currency || ""}
          </span>
        </div>
      </div>
    </div>
  );
}
