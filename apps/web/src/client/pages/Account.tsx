import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Field, Layout, Loading, LoadingPage } from "../components.tsx";
import { ApiError, api, errorMessage } from "../lib/api.ts";
import { authClient, isPasskeyCancel, passkeyHint, passkeysSupported } from "../lib/auth.ts";
import { navigate } from "../lib/router.tsx";
import { useSession } from "../lib/session.tsx";
import { deviceName } from "./SignIn.tsx";

interface PasskeyRow {
  id: string;
  name?: string | null;
  createdAt?: string | Date | null;
}

export function AccountPage() {
  const { state, refresh } = useSession();
  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    const res = await authClient.passkey.listUserPasskeys();
    setLoadFailed(Boolean(res.error));
    setPasskeys(res.error ? [] : ((res.data ?? []) as PasskeyRow[]));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (state.status !== "ready" || !state.me.user) return <LoadingPage />;
  const me = state.me;

  const add = async () => {
    setBusy("add");
    setError("");
    setNotice("");
    const res = await authClient.passkey.addPasskey({ name: deviceName() });
    setBusy(null);
    if (res?.error) {
      if (!isPasskeyCancel(res.error)) setError("The passkey was not saved. Please try again.");
    } else {
      passkeyHint.markUsed();
      setNotice("Passkey saved. Next time, sign in without an email code.");
      await Promise.all([load(), refresh()]);
    }
  };

  const remove = async (passkey: PasskeyRow) => {
    const label = describe(passkey);
    if (!confirm(`Remove the passkey “${label}”? You can still sign in with an email code.`))
      return;
    const id = passkey.id;
    setBusy(id);
    setError("");
    setNotice("");
    const res = await authClient.passkey.deletePasskey({ id });
    setBusy(null);
    if (res.error) setError("Could not remove that passkey. Please try again.");
    else {
      setNotice(`Removed the passkey “${label}”.`);
      await Promise.all([load(), refresh()]);
    }
  };

  const signOut = async () => {
    setBusy("signout");
    await authClient.signOut();
    await refresh();
    navigate("/signin", { replace: true });
  };

  return (
    <Layout title="Your account">
      <section className="card account-card" aria-label="Signed in">
        <div>
          <p>
            Signed in as <strong>{me.user?.email}</strong>
          </p>
          {me.membership?.family && <p className="muted">Family: {me.membership.family.name}</p>}
        </div>
        <Button
          variant="secondary"
          onClick={signOut}
          busy={busy === "signout"}
          busyLabel="Signing out…"
        >
          Sign out
        </Button>
      </section>

      <section className="card" aria-labelledby="passkeys-heading">
        <h2 id="passkeys-heading" className="section-title">
          Quick sign-in (passkeys)
        </h2>
        <p className="muted">
          Sign in with Face ID, a fingerprint or your screen lock instead of an email code.
        </p>
        <Alert>{error}</Alert>
        <Alert kind="success">{notice}</Alert>
        {loadFailed && (
          <Alert>
            Could not load your passkeys.{" "}
            <Button variant="link" onClick={() => void load()}>
              Try again
            </Button>
          </Alert>
        )}
        {passkeys === null ? (
          <Loading label="Loading passkeys…" />
        ) : loadFailed ? null : passkeys.length === 0 ? (
          <p>No passkeys saved yet.</p>
        ) : (
          <ul className="list">
            {passkeys.map((p) => (
              <li key={p.id}>
                <span>{describe(p)}</span>
                <Button
                  variant="secondary"
                  onClick={() => remove(p)}
                  busy={busy === p.id}
                  busyLabel="Removing…"
                  aria-label={`Remove passkey ${describe(p)}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {passkeysSupported() ? (
          <p>
            <Button
              variant="secondary"
              onClick={add}
              busy={busy === "add"}
              busyLabel="Waiting for your device…"
            >
              Add a passkey on this device
            </Button>
          </p>
        ) : (
          <p className="muted">
            This browser cannot save passkeys. You can keep signing in with an email code.
          </p>
        )}
      </section>

      {me.membership?.family && <ReminderSetting />}

      <DeleteAccount />
    </Layout>
  );
}

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** "iPhone, added 3 Nov 2026", so two passkeys with the same name can be told apart. */
function describe(passkey: PasskeyRow): string {
  const name = passkey.name || "Passkey";
  return passkey.createdAt ? `${name}, added ${DATE.format(new Date(passkey.createdAt))}` : name;
}

/** Turn the family's due-date reminder emails on or off. */
function ReminderSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    api<{ on: boolean }>("/family/reminders")
      .then((res) => setOn(res.on))
      .catch(() => setOn(null));
  }, []);
  if (on === null) return null;
  const change = async (next: boolean) => {
    setBusy(true);
    setMessage("");
    try {
      const res = await api<{ on: boolean }>("/family/reminders", {
        method: "PUT",
        body: { on: next },
      });
      setOn(res.on);
      setMessage(res.on ? "Reminders are on." : "Reminders are off.");
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="reminders-heading">
      <h2 id="reminders-heading" className="section-title">
        Reminder emails
      </h2>
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={(e) => void change(e.target.checked)}
        />
        Email my family when books are due back or late
      </label>
      <p className="muted" role="status">
        {message || "You'll always get an email when you borrow, whatever you choose here."}
      </p>
    </section>
  );
}

/** "Delete my account": checks nothing blocks it, then confirms with an emailed code. */
function DeleteAccount() {
  const { state, refresh } = useSession();
  const user = state.status === "ready" ? state.me.user : null;
  const [step, setStep] = useState<"idle" | "blocked" | "code">("idle");
  const [blocked, setBlocked] = useState<{ books: { title: string }[]; lastAdmin: boolean } | null>(
    null,
  );
  const [familyGoes, setFamilyGoes] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api<{ codeSent: boolean; familyWillBeRemoved: boolean }>(
        "/account/delete/start",
        { body: {} },
      );
      setFamilyGoes(res.familyWillBeRemoved);
      setStep("code");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.details) {
        setBlocked({
          books: (e.details.books as { title: string }[] | undefined) ?? [],
          lastAdmin: e.details.lastAdmin === true,
        });
        setStep("blocked");
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/account/delete/confirm", { body: { code } });
      await refresh();
      navigate("/signin?deleted=1", { replace: true });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <section className="card card--danger" aria-labelledby="delete-heading">
      <h2 id="delete-heading" className="section-title">
        Delete my account
      </h2>
      <Alert>{error}</Alert>
      {step === "idle" && (
        <>
          <p className="muted">
            Signs you out everywhere and removes your email and sign-in from the library straight
            away. If you're the last parent in your family, the family is removed too. Books
            borrowed in the past stay in the library's counts without your name.
          </p>
          <Button variant="secondary" onClick={start} busy={busy} busyLabel="Checking…">
            Delete my account
          </Button>
        </>
      )}
      {step === "blocked" && (
        <div className="stack">
          <Alert kind="info">
            {blocked?.lastAdmin ? (
              "You're the library's only admin. Invite another admin first (Admin › Families › Staff), then you can delete your account."
            ) : (
              <>
                Your family still has {blocked?.books.length === 1 ? "a book" : "books"} out. Please
                return {blocked?.books.length === 1 ? "it" : "them"} first, then you can delete your
                account:
                <ul className="plain">
                  {blocked?.books.map((b) => (
                    <li key={b.title}>{b.title}</li>
                  ))}
                </ul>
              </>
            )}
          </Alert>
          <Button variant="secondary" onClick={start} busy={busy} busyLabel="Checking…">
            Check again
          </Button>
        </div>
      )}
      {step === "code" && (
        <div className="stack">
          <p id="delete-code-help">
            We've emailed {user?.email ?? "you"} a 6-digit code. Enter it to delete your account.
            {familyGoes && " Your family will be removed from the library too."}{" "}
            <strong>This can't be undone.</strong>
          </p>
          <Field
            label="6-digit code"
            className="code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            enterKeyHint="done"
            autoFocus
            describedBy="delete-code-help"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
          <div className="row">
            <Button
              variant="danger"
              onClick={confirmDelete}
              disabled={code.length !== 6}
              busy={busy}
              busyLabel="Deleting…"
            >
              Yes, delete my account permanently
            </Button>
            <Button variant="secondary" onClick={() => setStep("idle")}>
              Keep my account
            </Button>
          </div>
          <Button variant="link" onClick={start} busy={busy}>
            Send a new code
          </Button>
        </div>
      )}
    </section>
  );
}
