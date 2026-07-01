import { GLOBAL_REPORT_PRINT_CSS } from "./reportPrintLayout.js";
import { GLOBAL_REPORT_TABLE_CSS } from "./reportTableLayout.js";

/** Shared print styles for quotation-style sales documents (quotation, OA, etc.). */
export const SALES_QUOTATION_STYLE_PRINT_CSS = `
          body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
          body.report-print.has-quote-terms { padding-bottom: 0; }
          body.report-print.has-quote-terms .print-body {
            padding-bottom: 72mm;
          }
          .quote-header {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            align-items: center;
            width: 100%;
            padding: 20px 30px;
            border-bottom: 2px solid #e5e7eb;
            box-sizing: border-box;
            min-height: 118px;
            margin-bottom: 16px;
          }
          .quote-left {
            display: flex;
            align-items: center;
            justify-content: flex-start;
          }
          .quote-center { text-align: center; }
          .quote-right { text-align: right; }
          .quote-logo {
            max-width: 208px;
            height: auto;
            object-fit: contain;
          }
          .quote-title {
            font-size: 22px;
            font-weight: 700;
            margin-bottom: 5px;
          }
          .quote-meta {
            font-size: 13px;
            color: #555;
            line-height: 1.5;
          }
          .company-name {
            font-size: 32px;
            font-weight: 800;
            letter-spacing: 1px;
            color: #1f3a5f;
            line-height: 1;
          }
          .company-subtitle {
            font-size: 14px;
            font-weight: 600;
            color: #2c5282;
            margin-top: 4px;
          }
          .company-details {
            font-size: 12px;
            color: #4a5568;
            line-height: 1.6;
            margin-top: 8px;
          }
          .header {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            align-items: center;
            width: 100%;
            padding: 20px 30px;
            border-bottom: 2px solid #e5e7eb;
            box-sizing: border-box;
            min-height: 118px;
            margin-bottom: 16px;
            page-break-inside: avoid;
          }
          .header-left, .header-center, .header-right {
            min-width: 0;
          }
          .header-left {
            display: flex;
            justify-content: flex-start;
            align-items: center;
          }
          .logo {
            width: 190px;
            height: auto;
            object-fit: contain;
            image-rendering: auto;
            image-rendering: -webkit-optimize-contrast;
          }
          .brand-fallback {
            font-weight: 800;
            font-size: 28px;
            color: #1f5a96;
            letter-spacing: 0.5px;
          }
          .header-center {
            text-align: center;
          }
          .header-right {
            text-align: right;
          }
          .header-right.is-marivolt {
            text-align: right;
          }
          .brand-title {
            margin: 0;
            line-height: 1;
            font-size: 32px;
            font-weight: 800;
            color: #1f3a5f;
          }
          .brand-subtitle {
            margin-top: 4px;
            font-size: 14px;
            font-weight: 700;
            letter-spacing: 0.4px;
            color: #1f4e79;
          }
          .title { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
          .muted { color: #555; font-size: 12px; line-height: 1.5; }
          .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 10px 0 6px; }
          .info-box {
            border: 1px solid #e5e7eb;
            border-radius: 10px;
            padding: 10px 12px;
            background: #fafafa;
            min-height: 156px;
            box-sizing: border-box;
          }
          .info-box-title { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6b7280; margin-bottom: 6px; letter-spacing: 0.3px; }
          table.report-table,
          table.report-lines-table,
          table.po-lines-table {
            margin-top: 12px;
          }
          table:not(.si-bank-table):not(.report-table):not(.report-lines-table):not(.po-lines-table) {
            width: 100%;
            border-collapse: collapse;
            margin-top: 12px;
          }
          table:not(.si-bank-table):not(.report-table):not(.report-lines-table):not(.po-lines-table) th,
          table:not(.si-bank-table):not(.report-table):not(.report-lines-table):not(.po-lines-table) td {
            border: 1px solid #ddd;
            padding: 8px;
            font-size: 12px;
          }
          .right { text-align: right; }
          .totals { margin-top: 12px; width: 320px; margin-left: auto; }
          .totals div { display: flex; justify-content: space-between; font-size: 12px; padding: 3px 0; }
          .footer { margin-top: 30px; font-size: 12px; color: #444; }
          .quote-terms {
            margin-top: 28px;
            margin-bottom: 16px;
            padding: 12px 14px;
            font-size: 11px;
            line-height: 1.55;
            color: #374151;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            background: #f9fafb;
          }
          .quote-terms a { color: #1d4ed8; word-break: break-all; }
          .doc-note {
            margin-top: 30px;
            text-align: center;
            font-size: 11px;
            color: #4b5563;
            border-top: 1px dashed #cfd8e3;
            padding-top: 10px;
          }
          .page-footer {
            position: static;
            left: auto;
            right: auto;
            bottom: auto;
            color: #1f3a5f;
            font-size: 12px;
          }
          .page-footer-top {
            display: grid;
            grid-template-columns: 1fr 1.2fr 1fr;
            gap: 12px;
            align-items: start;
          }
          .page-footer-center { text-align: center; }
          .page-footer-right { text-align: right; }
          .page-footer-line {
            display: none;
          }
          .si-tax-print-wrap { margin-top: 10px; margin-bottom: 14px; page-break-inside: avoid; }
          .si-header-3col {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 10px;
            align-items: stretch;
          }
          .si-mid-stack { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
          .si-hbox-tax {
            border: 1px solid #e5e7eb;
            border-radius: 10px;
            padding: 10px 12px;
            background: #fafafa;
            font-size: 11px;
            line-height: 1.45;
            color: #374151;
            min-width: 0;
            box-sizing: border-box;
          }
          .si-hbox-stretch { align-self: stretch; display: flex; flex-direction: column; }
          .si-hbox-title {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.3px;
            color: #6b7280;
            margin-bottom: 6px;
          }
          .si-hbox-body { flex: 1; color: #111; word-break: break-word; }
          .si-hbox-body a { color: #1d4ed8; }
          .si-customer-name { font-weight: 600; color: #111; margin-bottom: 4px; }
          .si-customer-addr { white-space: normal; word-break: break-word; }
          .si-customer-vat { margin-top: 8px; font-size: 11px; }
          .si-currency-eur { color: #cc0000; font-weight: 700; }
          .si-bank-block { margin-top: 16px; page-break-inside: avoid; }
          .si-bank-table { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed; }
          .si-bank-td {
            border: 1px solid #d1d5db;
            padding: 10px 12px;
            vertical-align: top;
            width: 50%;
          }
          .si-bank-detail-text { margin: 6px 0 8px; line-height: 1.45; color: #111; }
          .si-bank-missing { line-height: 1.45; }
          .si-amount-words { margin-top: 8px; line-height: 1.5; font-weight: 600; color: #111; }
          .si-corr-head { font-weight: 700; margin-bottom: 8px; letter-spacing: 0.02em; }
          .si-signature-wrap { text-align: left; }
          .si-signature-box {
            margin-top: 8px;
            min-height: 72px;
            border: 1px dashed #9ca3af;
            border-radius: 4px;
            background: #fafafa;
          }
          .si-corr-block { margin-top: 12px; padding-top: 10px; border-top: 1px dashed #e5e7eb; }
          .si-beneficiary-cell { line-height: 1.45; }
          .si-beneficiary-inner { margin-top: 8px; font-size: 11px; color: #111; }
          .si-beneficiary-line { line-height: 1.5; }
          .si-beneficiary-addr { margin-top: 4px; color: #374151; }
          @media print {
            html, body {
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
              color-adjust: exact !important;
            }
            * {
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
              color-adjust: exact !important;
            }
            .brand-title { color: #1f3a5f !important; }
            .brand-subtitle { color: #1f4e79 !important; }
            .brand-fallback { color: #1f5a96 !important; }
            .page-footer { color: #1f3a5f !important; }
            body.report-print.has-quote-terms .print-page,
            body.report-print.has-quote-terms .print-body {
              padding-bottom: 72mm !important;
            }
            th { background: #f5f5f5 !important; color: #111 !important; }
            .info-box {
              background: #fafafa !important;
              border-color: #e5e7eb !important;
            }
            table, th, td {
              border-color: #d6d6d6 !important;
            }
            .header { page-break-inside: avoid; }
            .quote-header { page-break-inside: avoid; }
            .quote-terms { page-break-inside: avoid; }
          }
${GLOBAL_REPORT_PRINT_CSS}
${GLOBAL_REPORT_TABLE_CSS}
`;
