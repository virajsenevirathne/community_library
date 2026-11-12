import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Alert, Button, Field, Loading } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";

interface WebhookData {
  events: string[];
  webhook: { url: string; secret: string; events: string[] } | null;
  recent: {
    id: string;
    event: string;
    status: "pending" | "sent" | "failed";
    attempts: number;
    lastStatus: number | null;
    createdAt: number;
  }[];
}

const EVENT_LABELS: Record<string, string> = {
  "loan.created": "A book is borrowed",
  "loan.returned": "A book is returned (or marked lost or damaged)",
  "loan.overdue": "A book becomes overdue",
  "account.deleted": "A family or parent leaves",
};

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Settings › Webhooks: for libraries with their own systems (a school's,
 * a spreadsheet script). Optional; most libraries never need it.
 */
export function WebhookSettings() {
  const [data, setData] = useState<WebhookData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const load = useCallback(async () => {
    try {
      const found = await api<WebhookData>("/admin/webhook");
      setData(found);
      setUrl(found.webhook?.url ?? "");
      setEvents(found.webhook?.events ?? found.events);
      setLoadError("");
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, request: () => Promise<unknown>, message: string) => {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await request();
      await load();
      setNotice(message);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const ok = await run(
      "save",
      () => api("/admin/webhook", { method: "PUT", body: { url: url.trim(), events } }),
      "Webhook saved.",
    );
    if (ok) setOpen(false);
  };

  const test = async () => {
    setBusy("test");
    setError("");
    setNotice("");
    try {
      const res = await api<{ ok: boolean; status: number }>("/admin/webhook/test", { body: {} });
      await load();
      if (res.ok) setNotice(`Test sent: the address answered ${res.status}.`);
      else
        setError(
          res.status
            ? `Test sent, but the address answered ${res.status}.`
            : "The address couldn't be reached.",
        );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const hook = data?.webhook ?? null;
  return (
    <section className="card stack" aria-labelledby="webhook-heading">
      <h2 id="webhook-heading" className="section-title">
        Webhooks
      </h2>
      <p className="muted">
        For libraries with their own system: we can tell an address of yours whenever a book is
        borrowed or returned. Messages hold the book and dates, never names or email addresses. Most
        libraries don't need this.
      </p>
      <Alert>{error || loadError}</Alert>
      <Alert kind="success">{notice}</Alert>
      {!data && !loadError && <Loading />}
      {data && hook && !open && (
        <>
          <p>
            Sending to <span className="code">{hook.url}</span>
            <br />
            <span className="muted">{hook.events.map((e) => EVENT_LABELS[e] ?? e).join("; ")}</span>
          </p>
          <div>
            <p className="muted">
              Signing secret: check the <span className="code">Reading-Joey-Signature</span> header
              with it, so you know a message is really from us.
            </p>
            {showSecret ? (
              <input
                className="join-link__url"
                readOnly
                value={hook.secret}
                aria-label="Signing secret"
                onFocus={(e) => e.target.select()}
              />
            ) : (
              <Button variant="link" onClick={() => setShowSecret(true)}>
                Show the secret
              </Button>
            )}
          </div>
          <div className="row">
            <Button variant="secondary" onClick={test} busy={busy === "test"} busyLabel="Sending…">
              Send a test
            </Button>
            <Button variant="secondary" onClick={() => setOpen(true)}>
              Change
            </Button>
            <Button
              variant="secondary"
              busy={busy === "secret"}
              busyLabel="Replacing…"
              onClick={() =>
                void run(
                  "secret",
                  () => api("/admin/webhook/secret", { body: {} }),
                  "New secret made. Update it where you check signatures: the old one no longer matches.",
                )
              }
            >
              New secret
            </Button>
            <Button
              variant="link"
              busy={busy === "remove"}
              onClick={() =>
                void run(
                  "remove",
                  () => api("/admin/webhook", { method: "DELETE" }),
                  "Webhook removed. Nothing more will be sent.",
                )
              }
            >
              Remove webhook
            </Button>
          </div>
          {data.recent.length > 0 && (
            <details>
              <summary>Latest messages</summary>
              <ul className="plain">
                {data.recent.map((d) => (
                  <li key={d.id}>
                    {WHEN.format(d.createdAt)} · {d.event} ·{" "}
                    {d.status === "sent"
                      ? `delivered (${d.lastStatus})`
                      : d.status === "failed"
                        ? `gave up after ${d.attempts} tries (${d.lastStatus || "no answer"})`
                        : `will try again (${d.lastStatus || "no answer"})`}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {data && (open || !hook) && (
        <form className="stack" onSubmit={save} noValidate>
          {!open && !hook ? (
            <Button variant="secondary" onClick={() => setOpen(true)}>
              Set up a webhook
            </Button>
          ) : (
            <>
              <Field
                label="Address to send to"
                hint="An https address, such as https://example.org/library-hook"
                type="url"
                inputMode="url"
                autoComplete="off"
                maxLength={500}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <fieldset className="field">
                <legend>Tell it when</legend>
                {data.events.map((e) => (
                  <label key={e} className="check">
                    <input
                      type="checkbox"
                      checked={events.includes(e)}
                      onChange={(ev) =>
                        setEvents(
                          ev.target.checked ? [...events, e] : events.filter((x) => x !== e),
                        )
                      }
                    />
                    {EVENT_LABELS[e] ?? e}
                  </label>
                ))}
              </fieldset>
              <div className="row">
                <Button type="submit" busy={busy === "save"} busyLabel="Saving…">
                  Save webhook
                </Button>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </form>
      )}
    </section>
  );
}
