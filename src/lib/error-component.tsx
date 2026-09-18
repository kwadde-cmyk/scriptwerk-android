import type { ErrorComponentProps } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";

export function AppErrorComponent({ error }: ErrorComponentProps) {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const stale = /failed to fetch dynamically imported module/i.test(raw);
  const message = stale
    ? "Die Vorschau hat den Anschluss verloren. Neu laden stellt Scriptwerk wieder her."
    : raw || "Unerwarteter Fehler. Bitte neu laden.";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-fg">
      <span className="text-danger" aria-hidden="true">
        <TriangleAlert className="size-10" strokeWidth={2} />
      </span>
      <h1 className="font-display text-lg tracking-tight">Etwas ist schiefgelaufen</h1>
      <p className="max-w-md text-sm text-pretty break-words text-fg-muted">{message}</p>
      <button
        type="button"
        className="mt-2 rounded-md border border-border bg-elevated px-4 py-2 text-sm hover:bg-muted"
        onClick={() => window.location.reload()}
      >
        Neu laden
      </button>
    </main>
  );
}
