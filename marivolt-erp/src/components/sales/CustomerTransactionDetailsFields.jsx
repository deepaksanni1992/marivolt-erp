import { FormField, TextInput } from "../erp/FormField.jsx";
import { CUSTOMER_FIELD_LIMITS } from "../../lib/customerTransactionFields.js";

const textareaClass =
  "w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900 disabled:bg-gray-50";

/**
 * Reusable Contact Person / Attention / Payment Terms / Billing / Shipping
 * for Quotation, OA, PI, and Sales Invoice forms.
 */
export default function CustomerTransactionDetailsFields({
  values = {},
  onChange,
  disabled = false,
  showPaymentTerms = true,
  customerRefLabel = null,
  customerRefValue = null,
  onCustomerRefChange = null,
  compact = false,
}) {
  const set = (key) => (e) => {
    if (disabled || typeof onChange !== "function") return;
    onChange(key, e.target.value);
  };

  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {customerRefLabel && typeof onCustomerRefChange === "function" ? (
          <FormField label={customerRefLabel}>
            <TextInput
              value={customerRefValue || ""}
              disabled={disabled}
              onChange={onCustomerRefChange}
            />
          </FormField>
        ) : null}
        <FormField label="Contact Person">
          <TextInput
            value={values.contactPerson || ""}
            disabled={disabled}
            maxLength={CUSTOMER_FIELD_LIMITS.contactPerson}
            onChange={set("contactPerson")}
            placeholder="Contact person"
          />
        </FormField>
        <FormField label="Attention">
          <TextInput
            value={values.attention || ""}
            disabled={disabled}
            maxLength={CUSTOMER_FIELD_LIMITS.attention}
            onChange={set("attention")}
            placeholder="Attention"
          />
        </FormField>
      </div>
      {showPaymentTerms ? (
        <FormField label="Payment Terms">
          <textarea
            rows={5}
            className={textareaClass}
            value={values.paymentTerms || ""}
            disabled={disabled}
            maxLength={CUSTOMER_FIELD_LIMITS.paymentTerms}
            onChange={set("paymentTerms")}
            placeholder={"e.g.\n100% Advance against PI.\nDispatch after receipt of full payment."}
          />
        </FormField>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Billing Address">
          <textarea
            rows={4}
            className={textareaClass}
            value={values.billingAddress || ""}
            disabled={disabled}
            maxLength={CUSTOMER_FIELD_LIMITS.billingAddress}
            onChange={set("billingAddress")}
            placeholder="Billing address"
          />
        </FormField>
        <FormField label="Shipping Address">
          <textarea
            rows={4}
            className={textareaClass}
            value={values.shippingAddress || ""}
            disabled={disabled}
            maxLength={CUSTOMER_FIELD_LIMITS.shippingAddress}
            onChange={set("shippingAddress")}
            placeholder="Shipping address"
          />
        </FormField>
      </div>
    </div>
  );
}
