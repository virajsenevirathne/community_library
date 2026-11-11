import { type FormEvent, useRef, useState } from "react";
import { Scanner, signal } from "../../components/Scanner.tsx";
import { Button, Field, Layout } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { lateText, parseCopyCode } from "../../lib/copies.ts";

interface Result {
  key: number;
  code: string;
  kind: "ok" | "late" | "already" | "error";
  title: string;
  detail: string;
}

const ICONS: Record<Result["kind"], string> = { ok: "✓", late: "!", already: "↺", error: "✗" };
const LABELS: Record<Result["kind"], string> = {
  ok: "Checked in",
  late: "Checked in, late",
  already: "Already checked in",
  error: "Problem",
};

/**
 * Bulk return: staff scan a basket of books one after another. Each scan
 * closes that copy's loan, whoever has it. The latest result is shown large
 * right under the camera, with a sound, so staff can keep scanning.
 */
export function BulkReturnPage() {
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState("");
  const counter = useRef(0);
  const busyRef = useRef(false);
  // Codes checked in this session: scanning one again does not call the server.
  const seen = useRef(new Set<string>());

  const add = (result: Omit<Result, "key">) => {
    signal(result.kind === "error" ? "error" : "ok");
    setResults((r) => [{ ...result, key: ++counter.current }, ...r]);
  };

  /** Checks one code in. Returns false if another check-in is still running. */
  const checkIn = async (code: string): Promise<boolean> => {
    if (busyRef.current) return false;
    if (seen.current.has(code)) {
      add({ code, kind: "already", title: code, detail: "Scanned already in this basket." });
      return true;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await api<{
        alreadyReturned?: boolean;
        copy: { title: { title: string } };
        returned?: { familyName?: string; overdueDays: number; wasFound: boolean };
      }>(`/copies/${code}/return`, { body: {} });
      seen.current.add(code);
      const title = res.copy.title.title;
      if (res.alreadyReturned) {
        add({ code, kind: "already", title, detail: "It was already checked in." });
      } else {
        const late = lateText(res.returned?.overdueDays ?? 0);
        const parts = [res.returned?.familyName ? `From ${res.returned.familyName}` : "Checked in"];
        if (late) parts.push(late);
        if (res.returned?.wasFound) parts.push("it had been reported found");
        add({ code, kind: late ? "late" : "ok", title, detail: `${parts.join(" · ")}.` });
      }
    } catch (e) {
      add({ code, kind: "error", title: code, detail: errorMessage(e) });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    return true;
  };

  const submitTyped = async (event: FormEvent) => {
    event.preventDefault();
    const code = parseCopyCode(typed);
    if (!code) {
      setTypedError("That code doesn't look right. It's 4 letters or numbers, like K7R2.");
      return;
    }
    // Only clear the field once the code was taken.
    if (await checkIn(code)) setTyped("");
  };

  const latest = results[0];
  const checkedIn = results.filter((r) => r.kind === "ok" || r.kind === "late").length;

  return (
    <Layout title="Check in returns" back="/admin">
      <p className="lead">
        Scan the QR sticker inside each book from the returns basket. Each one is checked in,
        whoever had it.
      </p>
      <Scanner
        label="Camera view for scanning book stickers"
        hint="Point the camera at the QR sticker inside the front cover"
        typeWhat="code"
        formats={["qr_code"]}
        accept={parseCopyCode}
        onScan={(code) => void checkIn(code)}
        paused={busy}
        sound={false}
      />
      <div aria-live="polite" aria-atomic="true">
        {latest && (
          <div
            className={`scan-result scan-result--${latest.kind === "late" || latest.kind === "already" ? "warn" : latest.kind}`}
          >
            <span className="scan-result__icon" aria-hidden="true">
              {ICONS[latest.kind]}
            </span>
            <span>
              <span className="visually-hidden">{LABELS[latest.kind]}: </span>
              <strong>{latest.title}</strong>
              <br />
              {latest.detail}
            </span>
          </div>
        )}
      </div>
      <form onSubmit={submitTyped} noValidate>
        <Field
          label="Or type a book code"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
          maxLength={200}
          error={typedError}
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value.toUpperCase());
            if (typedError) setTypedError("");
          }}
        />
        <Button type="submit" variant="secondary" busy={busy} busyLabel="Checking in…">
          Check in
        </Button>
      </form>
      <h2>{checkedIn === 0 ? "Nothing checked in yet" : `${checkedIn} checked in so far`}</h2>
      <ul className="list">
        {results.slice(1).map((r) => (
          <li key={r.key}>
            <span>
              <span aria-hidden="true">{ICONS[r.kind]} </span>
              <span className="visually-hidden">{LABELS[r.kind]}: </span>
              <strong>{r.title}</strong>{" "}
              <span className={r.kind === "error" || r.kind === "late" ? "late" : "muted"}>
                {r.detail}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Layout>
  );
}
