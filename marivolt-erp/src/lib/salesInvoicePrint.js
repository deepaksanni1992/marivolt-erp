/** Helpers for Tax invoice print: amount in words and bank footer HTML. */

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];

const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

export function escapePrintHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Integer 0 .. ~1e12 to English words (no "and" between thousands per common invoice style). */
export function intToEnglishWords(n) {
  const num = Math.floor(Math.abs(Number(n) || 0));
  if (num === 0) return "Zero";

  function under100(x) {
    if (x < 20) return ONES[x];
    const t = Math.floor(x / 10);
    const o = x % 10;
    return TENS[t] + (o ? " " + ONES[o] : "");
  }

  function under1000(x) {
    if (x < 100) return under100(x);
    const h = Math.floor(x / 100);
    const rest = x % 100;
    return ONES[h] + " Hundred" + (rest ? " " + under100(rest) : "");
  }

  function chunk(n0) {
    if (n0 < 1000) return under1000(n0);
    if (n0 < 1_000_000) {
      const t = Math.floor(n0 / 1000);
      const r = n0 % 1000;
      return chunk(t) + " Thousand" + (r ? " " + chunk(r) : "");
    }
    if (n0 < 1_000_000_000) {
      const m = Math.floor(n0 / 1_000_000);
      const r = n0 % 1_000_000;
      return chunk(m) + " Million" + (r ? " " + chunk(r) : "");
    }
    const b = Math.floor(n0 / 1_000_000_000);
    const r = n0 % 1_000_000_000;
    return chunk(b) + " Billion" + (r ? " " + chunk(r) : "");
  }

  return chunk(num);
}

function currencyLabelForWords(code) {
  const u = String(code || "").trim().toUpperCase();
  if (u === "EUR" || u === "EURO") return "Euro";
  if (u === "USD") return "US Dollar";
  if (u === "AED") return "UAE Dirham";
  if (!u) return "";
  return u;
}

function fractionalLabel(code) {
  const u = String(code || "").trim().toUpperCase();
  if (u === "AED") return "Fils";
  return "Cents";
}

/**
 * e.g. Euro Three Thousand Seven Hundred Sixty Five Only
 * with optional " and Fifty Cents" for non-zero decimal part.
 */
export function formatInvoiceAmountInWords(amount, currencyCode) {
  const cur = String(currencyCode || "USD").trim().toUpperCase();
  const label = currencyLabelForWords(cur === "EURO" ? "EUR" : cur);
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${label} Zero Only`;

  const rounded = Math.round(n * 100) / 100;
  const whole = Math.floor(Math.abs(rounded));
  const cents = Math.round(Math.abs(rounded) * 100 - whole * 100);

  let core = `${label} ${intToEnglishWords(whole)}`;
  if (cents > 0) {
    core += ` and ${intToEnglishWords(cents)} ${fractionalLabel(cur)}`;
  }
  return `${core} Only`;
}

/** Default beneficiary line for Marivolt-branded tax invoices when bank/company overrides are empty. */
export const MARIVOLT_DEFAULT_BENEFICIARY_LINE =
  "MARIVOLT FZE, Warehouse No. LV-09/B Hamriyah Free Zone Sharjah U.A.E.";

function buildBeneficiaryBodyHtml(esc, bankDetail, company) {
  const bn = (bankDetail?.beneficiaryName || "").trim();
  const ba = (bankDetail?.beneficiaryAddress || "").trim();
  if (bn || ba) {
    return `
      ${bn ? `<div>${esc(bn).replace(/\r?\n/g, "<br/>")}</div>` : ""}
      ${ba ? `<div class="si-beneficiary-addr">${esc(ba).replace(/\r?\n/g, "<br/>")}</div>` : ""}`;
  }
  const compName = String(company?.name || company?.companyName || "").toLowerCase();
  if (compName.includes("marivolt")) {
    return `<div class="si-beneficiary-line">${esc(MARIVOLT_DEFAULT_BENEFICIARY_LINE)}</div>`;
  }
  const fallbackName = String(company?.name || company?.companyName || "").trim();
  const fallbackAddr = String(company?.address || "").trim();
  if (!fallbackName && !fallbackAddr) return `<div class="muted">—</div>`;
  return `
    ${fallbackName ? `<div>${esc(fallbackName).replace(/\r?\n/g, "<br/>")}</div>` : ""}
    ${fallbackAddr ? `<div class="si-beneficiary-addr">${esc(fallbackAddr).replace(/\r?\n/g, "<br/>")}</div>` : ""}`;
}

export function renderSiBankFooterHtml({ bankDetail, amountInWords, company, docCurrency }) {
  const esc = escapePrintHtml;
  const purposeDefault = "Purchase of Spare Parts";
  const missingMsg = `No bank details found for invoice currency <b>${esc(docCurrency || "-")}</b>. Add a matching row in Accounts → Bank details (currency EUR/EURO, AED, or USD).`;

  let bankLinesHtml = "";
  let accountAndIbanLines = "";
  let swiftLine = "";
  let purposeLine = "";
  let corrHtml = "";

  if (bankDetail) {
    const parts = [bankDetail.bankName, bankDetail.bankAddress, bankDetail.branchName]
      .map((x) => String(x || "").trim())
      .filter(Boolean);
    bankLinesHtml = parts.map((line) => `<div>${esc(line).replace(/\r?\n/g, "<br/>")}</div>`).join("");
    const acctNum = String(bankDetail.accountNumber || "").trim();
    const ibanVal = String(bankDetail.iban || "").trim();
    accountAndIbanLines = `<div><b>Account number :</b> ${acctNum ? esc(acctNum) : "—"}</div><div><b>IBAN :</b> ${ibanVal ? esc(ibanVal) : "—"}</div>`;
    swiftLine = `<div><b>Swift Code :</b> ${esc(bankDetail.swiftCode || "—")}</div>`;
    const purpose = (bankDetail.purposeOfPayment || "").trim() || purposeDefault;
    purposeLine = `<div><b>Purpose of Payment</b> "${esc(purpose)}"</div>`;

    const cb = (bankDetail.correspondentBankName || "").trim();
    const cs = (bankDetail.correspondentSwiftCode || "").trim();
    if (cb || cs) {
      corrHtml = `
        <div class="si-corr-block">
          <div class="si-corr-head">CORRESPONDENT BANK DETAILS</div>
          ${cb ? `<div><b>Bank Name :</b> ${esc(cb)}</div>` : ""}
          ${cs ? `<div><b>Swift Code :</b> ${esc(cs)}</div>` : ""}
        </div>`;
    }
  }

  const beneficiaryCellHtml = `
    <div><b>Beneficiary Details-</b></div>
    <div class="si-beneficiary-inner">${buildBeneficiaryBodyHtml(esc, bankDetail, company)}</div>`;

  const wordsBlock = `<div><b>Total Amount In Words :</b></div><div class="si-amount-words">${esc(amountInWords || "")}</div>`;

  return `
    <div class="si-bank-block">
      <table class="si-bank-table">
        <tbody>
          <tr>
            <td class="si-bank-td si-bank-td-left">
              <div><b>Bank Details :</b></div>
              ${
                bankDetail
                  ? `<div class="si-bank-detail-text">${bankLinesHtml}</div>${accountAndIbanLines}${swiftLine}${purposeLine}${corrHtml}`
                  : `<div class="si-bank-missing muted">${missingMsg}</div>`
              }
            </td>
            <td class="si-bank-td si-bank-td-right">${wordsBlock}</td>
          </tr>
          <tr>
            <td class="si-bank-td si-bank-td-left si-beneficiary-cell">${beneficiaryCellHtml}</td>
            <td class="si-bank-td si-bank-td-right si-signature-wrap">
              <div><b>Signature &amp; Stamp</b></div>
              <div class="si-signature-box"></div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>`;
}
