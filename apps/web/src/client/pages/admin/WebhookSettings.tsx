import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Field, Loading } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";

interface WebhookData {
  events: string[];
  webhook: { url: string; secretHint: string; events: string[] } | null;
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
  "loan.returned": "A book is returned, or marked lost or damaged",
  "loan.overdue": "A book becomes overdue",
  "account.deleted": "A family or parent leaves",
  ping: "Test message",
};

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

type Confirm = "remove" | "secret" | null;

function deliveryText(d: WebhookData["recent"][number]) {
  const answer = d.lastStatus ? `code ${d.lastStatus}` : "no answer";
  if (d.status === "sent") return "delivered";
  if (d.event === "ping") return `not delivered (${answer})`;
  if (d.status === "failed") return `gave up after ${d.attempts} tries (${answer})`;
  return `will try again (${answer})`;
}

/**
 * Settings › Connect your own system (webhooks). Optional, for libraries
 * with their own system; most never need it.
 */
export function WebhookSettings() {
  const [data, setData] = useState<WebhookData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [urlError, setUrlError] = useState("");
  const [eventsError, setEventsError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  /** A secret just made: shown this once, to copy into the library's system. */
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [focus, setFocus] = useState<"url" | "change" | "setup" | "secret" | "confirm" | null>(
    null,
  );
  const urlInput = useRef<HTMLInputElement>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const setupButton = useRef<HTMLButtonElement>(null);
  const secretInput = useRef<HTMLInputElement>(null);
  const confirmText = useRef<HTMLParagraphElement>(null);

  // The control pressed is often replaced: focus what took its place.
  useEffect(() => {
    const target = {
      url: urlInput,
      change: changeButton,
      setup: setupButton,
      secret: secretInput,
      confirm: confirmText,
    }[focus ?? "url"];
    if (focus) target.current?.focus();
    setFocus(null);
  }, [focus]);

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

  const clearMessages = () => {
    setError("");
    setNotice("");
  };

  const startEditing = () => {
    clearMessages();
    setUrlError("");
    setEventsError("");
    setEditing(true);
    setFocus("url");
  };
  const stopEditing = () => {
    setEditing(false);
    setUrl(data?.webhook?.url ?? "");
    setEvents(data?.webhook?.events ?? data?.events ?? []);
    setFocus(data?.webhook ? "change" : "setup");
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    clearMessages();
    const noEvents = events.length === 0 ? "Choose at least one." : "";
    setEventsError(noEvents);
    setUrlError("");
    if (noEvents) return;
    setBusy("save");
    try {
      const res = await api<{ secret?: string }>("/admin/webhook", {
        method: "PUT",
        body: { url: url.trim(), events },
      });
      await load();
      setEditing(false);
      if (res.secret) {
        setFreshSecret(res.secret);
        setNotice("Saved. Copy the secret code into your system now: it's shown only this once.");
        setFocus("secret");
      } else {
        setNotice("Saved. Send a test to check your system receives it.");
        setFocus("change");
      }
    } catch (e) {
      setUrlError(errorMessage(e));
      setFocus("url");
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    clearMessages();
    try {
      const res = await api<{ ok: boolean; status: number }>("/admin/webhook/test", { body: {} });
      await load();
      if (res.ok) setNotice("Test sent. Your system replied that all is well.");
      else if (res.status)
        setError(
          `Test sent, but your system didn't reply "OK" (it answered with code ${res.status}).`,
        );
      else setError("We couldn't reach that address. Check it, and that your system is running.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const confirmed = async () => {
    const which = confirm;
    setBusy(which);
    clearMessages();
    try {
      if (which === "remove") {
        await api("/admin/webhook", { method: "DELETE" });
        setNotice("Removed. Nothing more will be sent.");
      } else {
        const res = await api<{ secret: string }>("/admin/webhook/secret", { body: {} });
        setFreshSecret(res.secret);
        setNotice(
          "New secret code made. Copy it into your system now: it's shown only this once, and until then your system's check of our messages fails.",
        );
      }
      setConfirm(null);
      await load();
      setFocus(which === "remove" ? "setup" : "secret");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const copySecret = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      setNotice("Secret code copied.");
    } catch {
      setError("Couldn't copy. Select the code and copy it instead.");
    }
  };

  const hook = data?.webhook ?? null;
  return (
    <section className="card stack" aria-labelledby="webhook-heading">
      <h2 id="webhook-heading" className="section-title">
        Connect your own system
      </h2>
      <p className="muted">
        Optional, and technical: most libraries don't need this. If you have your own system (a
        school's, or a spreadsheet script), we can send it a message each time a book is borrowed or
        returned. Messages hold the book and dates, never names or email addresses. Ask whoever
        looks after your systems to set it up.
      </p>
      <Alert>{error || loadError}</Alert>
      <Alert kind="success">{notice}</Alert>
      {!data && !loadError && <Loading />}

      {data && hook && !editing && (
        <>
          <div>
            <p>Sending messages to</p>
            <p className="code code--url">{hook.url}</p>
            <ul className="plain muted">
              {hook.events.map((e) => (
                <li key={e}>{EVENT_LABELS[e] ?? e}</li>
              ))}
            </ul>
          </div>

          <details open={freshSecret !== null}>
            <summary>For your developer: the secret code</summary>
            <p className="muted">
              Each message carries a <span className="code">Reading-Joey-Signature</span> header
              made with this code, so your system can check it's really from us. The guide is in the
              project's docs/adapters.md.
            </p>
            {freshSecret ? (
              <div className="row">
                <input
                  ref={secretInput}
                  className="join-link__url"
                  readOnly
                  value={freshSecret}
                  aria-label="Secret code"
                  onFocus={(e) => e.target.select()}
                />
                <Button variant="secondary" onClick={() => void copySecret(freshSecret)}>
                  Copy secret code
                </Button>
              </div>
            ) : (
              <p className="muted">
                The code ends <span className="code">{hook.secretHint.slice(-4)}</span>. It's shown
                only when it's made: lost it? Make a new one.
              </p>
            )}
          </details>

          {confirm ? (
            <div className="confirm">
              <p className="confirm__text" ref={confirmText} tabIndex={-1}>
                {confirm === "remove"
                  ? "Stop sending messages, and forget the list of past ones?"
                  : "Make a new secret code? Your system's check of our messages fails until you give it the new one."}
              </p>
              <div className="row">
                <Button
                  variant="danger"
                  onClick={() => void confirmed()}
                  busy={busy === confirm}
                  busyLabel={confirm === "remove" ? "Removing…" : "Replacing…"}
                >
                  {confirm === "remove" ? "Stop sending" : "Make a new code"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setConfirm(null);
                    setFocus("change");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="row">
              <Button
                variant="secondary"
                onClick={test}
                busy={busy === "test"}
                busyLabel="Sending…"
              >
                Send a test
              </Button>
              <Button ref={changeButton} variant="secondary" onClick={startEditing}>
                Change
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirm("secret");
                  setFocus("confirm");
                }}
              >
                New secret code
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirm("remove");
                  setFocus("confirm");
                }}
              >
                Stop sending
              </Button>
            </div>
          )}

          {data.recent.length > 0 && (
            <details>
              <summary>Latest messages</summary>
              <ul className="plain">
                {data.recent.map((d) => (
                  <li key={d.id}>
                    <time dateTime={new Date(d.createdAt).toISOString()}>
                      {WHEN.format(d.createdAt)}
                    </time>{" "}
                    · {EVENT_LABELS[d.event] ?? d.event} · {deliveryText(d)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {data && !hook && !editing && (
        <Button ref={setupButton} variant="secondary" onClick={startEditing}>
          Set up a connection
        </Button>
      )}

      {data && editing && (
        <form className="stack" onSubmit={save} noValidate>
          <Field
            ref={urlInput}
            label="Address to send to"
            hint="An https address on the internet, such as https://example.org/library. Only replies with an OK code (2xx) count as received; redirects aren't followed."
            type="url"
            inputMode="url"
            autoComplete="off"
            maxLength={500}
            value={url}
            error={urlError}
            onChange={(e) => setUrl(e.target.value)}
          />
          <fieldset
            className="field"
            aria-describedby={eventsError ? "webhook-events-error" : undefined}
          >
            <legend>Send a message when</legend>
            {data.events.map((e) => (
              <label key={e} className="check">
                <input
                  type="checkbox"
                  checked={events.includes(e)}
                  onChange={(ev) => {
                    setEventsError("");
                    setEvents(ev.target.checked ? [...events, e] : events.filter((x) => x !== e));
                  }}
                />
                {EVENT_LABELS[e] ?? e}
              </label>
            ))}
            {eventsError && (
              <p className="field__error" id="webhook-events-error">
                {eventsError}
              </p>
            )}
          </fieldset>
          <div className="row">
            <Button type="submit" busy={busy === "save"} busyLabel="Saving…">
              Save
            </Button>
            <Button variant="secondary" onClick={stopEditing}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
