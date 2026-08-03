export function Spinner({ label }: { label?: string }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 text-sm text-slate-500"
    >
      <span
        aria-hidden="true"
        className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
      />
      {label ? <span>{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}
