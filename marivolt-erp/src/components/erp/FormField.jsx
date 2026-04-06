export function FormField({ label, children, className = "" }) {
  return (
    <div className={className}>
      {label ? (
        <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
      ) : null}
      {children}
    </div>
  );
}

export function TextInput(props) {
  return (
    <input
      {...props}
      className={[
        "w-full rounded-xl border border-gray-200 px-3 py-2 text-sm",
        "focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900",
        props.className || "",
      ].join(" ")}
    />
  );
}

export function SelectInput({ children, ...props }) {
  return (
    <select
      {...props}
      className={[
        "w-full rounded-xl border border-gray-200 px-3 py-2 text-sm bg-white",
        "focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900",
        props.className || "",
      ].join(" ")}
    >
      {children}
    </select>
  );
}
