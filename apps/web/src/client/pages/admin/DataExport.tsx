import { useState } from "react";
import { Alert, Button } from "../../components.tsx";
import { libraryBase } from "../../lib/router.tsx";

const FILES = [
  { kind: "catalog", label: "Catalog", detail: "Every book and copy, with its code and shelf" },
  { kind: "families", label: "Families", detail: "Families and their adults, with emails" },
  { kind: "loans", label: "Loans", detail: "Every loan still on record, out and returned" },
] as const;

/**
 * Settings › Your library's data: download it as spreadsheet files (CSV)
 * at any time, so the library is never locked in.
 */
export function DataExport() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const download = async (kind: (typeof FILES)[number]["kind"], label: string) => {
    setBusy(kind);
    setError("");
    setDone("");
    try {
      const base = libraryBase();
      const res = await fetch(`/api/admin/export/${kind}`, {
        headers: base ? { "X-Library": base } : {},
        credentials: "same-origin",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? "The download didn't work. Please try again.");
      }
      const name =
        res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `${kind}.csv`;
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setDone(`${label} downloaded as ${name}.`);
    } catch (e) {
      setError(
        e instanceof TypeError
          ? "Could not reach the library. Check your connection and try again."
          : e instanceof Error
            ? e.message
            : "The download didn't work. Please try again.",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card stack" aria-labelledby="data-heading">
      <h2 id="data-heading" className="section-title">
        Your library's data
      </h2>
      <p className="muted">
        Download it as spreadsheet files (CSV) whenever you like, to keep a copy or to move
        elsewhere. The families file holds parents' email addresses: keep it safe, and delete it
        when you no longer need it.
      </p>
      <Alert>{error}</Alert>
      <Alert kind="success">{done}</Alert>
      <ul className="plain">
        {FILES.map((f) => (
          <li key={f.kind} className="staff-row">
            <span>
              <strong>{f.label}</strong>
              <br />
              <span className="muted">{f.detail}</span>
            </span>
            <Button
              variant="secondary"
              busy={busy === f.kind}
              busyLabel="Preparing…"
              onClick={() => void download(f.kind, f.label)}
            >
              Download<span className="visually-hidden"> {f.label.toLowerCase()}</span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
