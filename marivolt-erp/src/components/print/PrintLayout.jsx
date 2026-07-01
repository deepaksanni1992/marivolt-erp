/**
 * React print layout primitives — mirror the HTML shell in printDocumentLayout.js.
 * Class names match buildPrintDocumentHtml() so screen preview and PDF export stay consistent.
 */

export function PrintLayout({ children, hasHeader = true, hasFooter = true, className = "" }) {
  const layoutClass = [
    "print-layout",
    hasHeader ? "has-print-header" : "",
    hasFooter ? "has-print-footer" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <div className={layoutClass}>{children}</div>;
}

export function PrintHeader({ children, className = "" }) {
  return <div className={`print-layout-header-slot print-header-slot ${className}`.trim()}>{children}</div>;
}

export function PrintContent({ children, className = "" }) {
  return <div className={`print-layout-content-slot print-content-slot ${className}`.trim()}>{children}</div>;
}

export function PrintFooter({ children, className = "" }) {
  return <div className={`print-layout-footer-slot print-footer-slot ${className}`.trim()}>{children}</div>;
}

export function PrintTermsSection({ children, className = "" }) {
  if (!children) return null;
  return (
    <section className={`print-terms-section ${className}`.trim()}>{children}</section>
  );
}
