/** Shared print styles for quotation-style sales documents (quotation, OA, etc.). */
export const SALES_QUOTATION_STYLE_PRINT_CSS = `
          body { font-family: Arial, sans-serif; margin: 24px; color: #111; padding-bottom: 90px; }
          body.has-quote-terms { padding-bottom: 155px; }
          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 20px;
            margin-bottom: 20px;
            page-break-inside: avoid;
          }
          .header-left, .header-center, .header-right {
            flex: 1;
            min-width: 0;
            padding: 6px 8px;
          }
          .header-left {
            display: flex;
            justify-content: flex-start;
            align-items: center;
          }
          .logo {
            height: 129px;
            width: 146px;
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
            text-align: center;
          }
          .header-right.is-marivolt {
            text-align: right;
          }
          .brand-title {
            margin: 0;
            line-height: 1;
            font-size: 32px;
            font-weight: 800;
            color: #e85d3f;
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
          table { width: 100%; border-collapse: collapse; margin-top: 12px; }
          th, td { border: 1px solid #ddd; padding: 8px; font-size: 12px; }
          th { background: #f5f5f5; text-align: left; }
          th.remarks-col, td.remarks-col { width: 22%; min-width: 180px; }
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
            position: fixed;
            left: 24px;
            right: 24px;
            bottom: 16px;
            color: #d6a327;
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
            margin-top: 8px;
            height: 5px;
            background: #e1aa24;
            border-radius: 2px;
          }
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
            .brand-title { color: #e85d3f !important; }
            .brand-subtitle { color: #1f4e79 !important; }
            .brand-fallback { color: #1f5a96 !important; }
            .page-footer { color: #d6a327 !important; }
            .page-footer-line { background: #e1aa24 !important; }
            th { background: #f5f5f5 !important; color: #111 !important; }
            .info-box {
              background: #fafafa !important;
              border-color: #e5e7eb !important;
            }
            table, th, td {
              border-color: #d6d6d6 !important;
            }
            .header { page-break-inside: avoid; }
            .quote-terms { page-break-inside: avoid; }
            .page-footer { position: fixed; bottom: 8px; }
          }
`;
