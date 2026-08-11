import { FormField, SelectInput, TextInput } from "../erp/FormField.jsx";
import {
  PO_ADJUSTMENT_TYPE_META,
  PO_ADJUSTMENT_TYPES,
  calcPoDiscountTotal,
  defaultPoAdjustmentLabel,
  formatPoDiscountPercent,
  poDiscountMode,
} from "../../lib/poTotals.js";

function nextAdjustmentKey() {
  return `adj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newPoAdjustmentRow(type = "CUSTOM") {
  const t = String(type || "CUSTOM").toUpperCase();
  return {
    key: nextAdjustmentKey(),
    type: t,
    label: t === "CUSTOM" ? "" : defaultPoAdjustmentLabel(t),
    amount: "",
    discountMode: t === "DISCOUNT" ? "FLAT" : undefined,
    discountValue: t === "DISCOUNT" ? "" : undefined,
  };
}

function usedSystemTypes(rows, exceptIndex = -1) {
  const used = new Set();
  (rows || []).forEach((row, i) => {
    if (i === exceptIndex) return;
    const t = String(row?.type || "").toUpperCase();
    if (t && t !== "CUSTOM") used.add(t);
  });
  return used;
}

function firstAvailableType(rows) {
  const used = usedSystemTypes(rows);
  const next = PO_ADJUSTMENT_TYPES.find((t) => t === "CUSTOM" || !used.has(t));
  return next || "CUSTOM";
}

export default function PoAdjustmentsEditor({
  adjustments = [],
  onChange,
  currency = "USD",
  subTotal = 0,
}) {
  const rows = Array.isArray(adjustments) ? adjustments : [];

  function updateRow(index, patch) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function changeType(index, type) {
    const t = String(type || "").toUpperCase();
    updateRow(index, {
      type: t,
      label: t === "CUSTOM" ? "" : defaultPoAdjustmentLabel(t),
      discountMode: t === "DISCOUNT" ? "FLAT" : undefined,
      discountValue: t === "DISCOUNT" ? "" : undefined,
      amount: "",
    });
  }

  function removeRow(index) {
    onChange(rows.filter((_, i) => i !== index));
  }

  function addRow() {
    onChange([...rows, newPoAdjustmentRow(firstAvailableType(rows))]);
  }

  return (
    <div className="w-full max-w-2xl space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Additional Costs / Adjustments
        </div>
        <button
          type="button"
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-800 hover:bg-gray-50"
          onClick={addRow}
        >
          + Add Cost / Adjustment
        </button>
      </div>

      {rows.length ? (
        <div className="space-y-2">
          {rows.map((row, index) => {
            const used = usedSystemTypes(rows, index);
            const isCustom = String(row.type) === "CUSTOM";
            const isDiscount = String(row.type) === "DISCOUNT";
            const discountMode = isDiscount ? poDiscountMode(row) : null;
            const isPercent = discountMode === "PERCENT";
            const derivedDiscount = isDiscount
              ? calcPoDiscountTotal(
                  subTotal,
                  discountMode,
                  isPercent ? row.discountValue : row.discountValue ?? row.amount
                )
              : 0;
            return (
              <div
                key={row.key || `${row.type}-${index}`}
                className="grid items-end gap-2 rounded-xl border border-gray-100 bg-gray-50/70 p-2 sm:grid-cols-12"
              >
                <FormField label="Type" className={isDiscount ? "sm:col-span-3" : "sm:col-span-4"}>
                  <SelectInput value={row.type} onChange={(e) => changeType(index, e.target.value)}>
                    {PO_ADJUSTMENT_TYPES.map((type) => (
                      <option key={type} value={type} disabled={type !== "CUSTOM" && used.has(type)}>
                        {PO_ADJUSTMENT_TYPE_META[type].label}
                      </option>
                    ))}
                  </SelectInput>
                </FormField>
                {isCustom ? (
                  <FormField label="Description" className="sm:col-span-4">
                    <TextInput
                      value={row.label ?? ""}
                      placeholder="e.g. Inspection Charges"
                      onChange={(e) => updateRow(index, { label: e.target.value })}
                    />
                  </FormField>
                ) : isDiscount ? (
                  <FormField label="Discount Type" className="sm:col-span-3">
                    <SelectInput
                      value={discountMode}
                      onChange={(e) =>
                        updateRow(index, {
                          discountMode: e.target.value,
                          amount: "",
                          discountValue: "",
                        })
                      }
                    >
                      <option value="FLAT">Flat Amount</option>
                      <option value="PERCENT">Percentage</option>
                    </SelectInput>
                  </FormField>
                ) : (
                  <div className="sm:col-span-4 pb-2 text-sm text-gray-600">
                    {defaultPoAdjustmentLabel(row.type)}
                  </div>
                )}
                {isDiscount && isPercent ? (
                  <FormField label="Percentage" className="sm:col-span-3">
                    <div className="flex items-center gap-1">
                      <TextInput
                        inputMode="decimal"
                        value={row.discountValue ?? ""}
                        placeholder="10"
                        onChange={(e) => updateRow(index, { discountValue: e.target.value })}
                      />
                      <span className="text-xs text-gray-500">%</span>
                    </div>
                  </FormField>
                ) : (
                  <FormField label="Amount" className="sm:col-span-3">
                    <TextInput
                      inputMode="decimal"
                      value={isDiscount ? (row.discountValue ?? row.amount ?? "") : (row.amount ?? "")}
                      placeholder="0.00"
                      onChange={(e) => {
                        if (isDiscount) {
                          updateRow(index, { discountValue: e.target.value, amount: e.target.value });
                        } else {
                          updateRow(index, { amount: e.target.value });
                        }
                      }}
                    />
                  </FormField>
                )}
                <div className="sm:col-span-1 pb-1">
                  <button
                    type="button"
                    className="w-full rounded-lg border border-gray-200 px-2 py-2 text-sm text-gray-500 hover:bg-white"
                    title="Remove"
                    onClick={() => removeRow(index)}
                  >
                    ×
                  </button>
                </div>
                {isDiscount && isPercent && String(row.discountValue ?? "").trim() !== "" ? (
                  <div className="sm:col-span-12 text-[11px] text-gray-500">
                    {formatPoDiscountPercent(row.discountValue)}% = {currency} {Number(derivedDiscount).toFixed(2)}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-[11px] text-gray-500">
          No additional costs. {currency} totals use line items only until you add a cost or discount.
        </p>
      )}
    </div>
  );
}
