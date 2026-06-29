import BankDetail from "../models/BankDetail.js";

const BANK_CURRENCY_GROUPS = {
  EUR: ["EUR", "EURO"],
  EURO: ["EUR", "EURO"],
  USD: ["USD"],
  AED: ["AED"],
};

export function currencyCodesForBankMatch(raw) {
  const u = String(raw || "USD").trim().toUpperCase();
  if (BANK_CURRENCY_GROUPS[u]) return BANK_CURRENCY_GROUPS[u];
  for (const arr of Object.values(BANK_CURRENCY_GROUPS)) {
    if (arr.includes(u)) return [...arr];
  }
  return [u];
}

export async function findBankDetailForCurrency(companyFilter, currency) {
  const codes = currencyCodesForBankMatch(currency);
  return BankDetail.findOne({ ...companyFilter, currency: { $in: codes } })
    .sort({ isDefault: -1, createdAt: -1 })
    .lean();
}

export function formatBankDetailAsPlainText(bankDetail) {
  if (!bankDetail) return "";
  const lines = [];
  const push = (label, value) => {
    const v = String(value || "").trim();
    if (!v) return;
    lines.push(label ? `${label}: ${v}` : v);
  };
  push("", bankDetail.bankName);
  push("", bankDetail.bankAddress);
  push("", bankDetail.branchName);
  push("Account name", bankDetail.accountName);
  push("Account number", bankDetail.accountNumber);
  push("IBAN", bankDetail.iban);
  push("Swift Code", bankDetail.swiftCode);
  push("Currency", bankDetail.currency);
  push("Beneficiary", bankDetail.beneficiaryName);
  push("Beneficiary address", bankDetail.beneficiaryAddress);
  push("Correspondent bank", bankDetail.correspondentBankName);
  push("Correspondent SWIFT", bankDetail.correspondentSwiftCode);
  push("Purpose of payment", bankDetail.purposeOfPayment);
  return lines.join("\n");
}

export async function resolveBankDetailsTextForCurrency(companyFilter, currency) {
  const row = await findBankDetailForCurrency(companyFilter, currency);
  return formatBankDetailAsPlainText(row);
}
