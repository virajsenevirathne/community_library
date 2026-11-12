import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Field, Layout, LibraryList, Loading, LoadingPage } from "../components.tsx";
import { ApiError, api, errorMessage } from "../lib/api.ts";
import { authClient, isPasskeyCancel, passkeyHint, passkeysSupported } from "../lib/auth.ts";
import { Link, navigate } from "../lib/router.tsx";
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

      <NameSetting />

      {me.membership?.family && <FamilySection />}

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

      {/* Site-wide, family settings belong to each library: point to them. */}
      {!me.library && me.libraries.length > 0 && (
        <section className="card" aria-labelledby="libraries-heading">
          <h2 id="libraries-heading" className="section-title">
            Your libraries
          </h2>
          <p className="muted">
            Your family and reminder emails are set in each library. Open one to change them.
          </p>
          <LibraryList libraries={me.libraries} />
        </section>
      )}
      {(me.owner || (me.library && me.libraries.length > 1)) && (
        <div className="row account-links">
          {me.library && me.libraries.length > 1 && (
            <Link href="/" absolute className="btn btn--secondary">
              Switch library
            </Link>
          )}
          {me.owner && (
            <Link href="/owner" absolute className="btn btn--secondary">
              Owner area
            </Link>
          )}
        </div>
      )}

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

/** Your first name, as your family and the library's staff see it. */
function NameSetting() {
  const { state, refresh } = useSession();
  const saved = state.status === "ready" ? (state.me.user?.name ?? "") : "";
  const [value, setValue] = useState(saved);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Follow the saved name, unless the person is in the middle of changing it.
  useEffect(() => {
    if (!dirty) setValue(saved);
  }, [saved, dirty]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) {
      setError("Type your first name.");
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/account/name", { method: "PUT", body: { firstName: value } });
      setDirty(false);
      await refresh();
      setMessage("Saved.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="name-heading">
      <h2 id="name-heading" className="section-title">
        Your name
      </h2>
      <form onSubmit={save} noValidate className="inline-form inline-form--flush">
        <Field
          ref={input}
          label="First name"
          hint={
            saved
              ? "Shown to your family and your library's staff."
              : "Add your first name so your family and the library staff can tell who's who."
          }
          autoComplete="given-name"
          maxLength={40}
          error={error}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setDirty(true);
            setError("");
            setMessage("");
          }}
        />
        <Button
          type="submit"
          variant="secondary"
          disabled={value.trim() === saved}
          busy={busy}
          busyLabel="Saving…"
        >
          Save name
        </Button>
        <p className="muted" role="status">
          {message}
        </p>
      </form>
    </section>
  );
}

interface FamilyData {
  family: { name: string; status: "active" | "pending" | "deactivated" };
  adults: { name: string; email: string; you: boolean }[];
  invites: { id: string; email: string; state: "queued" | "sent" | "expired" }[];
}

/** The adults in your family, and a way to add another (a partner, a grandparent). */
function FamilySection() {
  const [data, setData] = useState<FamilyData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const emailInput = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<FamilyData>("/family"));
      setLoadError("");
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim()) {
      setEmailError("Type their email address.");
      emailInput.current?.focus();
      return;
    }
    setBusy("invite");
    setEmailError("");
    setNotice("");
    try {
      const res = await api<{ sent: boolean }>("/family/invite", { body: { email } });
      setNotice(
        res.sent
          ? `Invitation sent to ${email}. Once they accept, you'll share one list of books.`
          : `Invitation for ${email} saved; it will be emailed shortly.`,
      );
      setEmail("");
      await load();
    } catch (e) {
      setEmailError(errorMessage(e));
      emailInput.current?.focus();
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (id: string, to: string) => {
    setBusy(id);
    setNotice("");
    setActionError("");
    try {
      await api(`/family/invites/${id}`, { method: "DELETE" });
      setNotice(`Invitation to ${to} cancelled.`);
      await load();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
      // The row (and its button) may be gone: carry on from the email box.
      emailInput.current?.focus();
    }
  };

  if (!data) {
    return (
      <section className="card" aria-label="Your family">
        {loadError ? (
          <Alert>
            Could not load your family. {loadError}{" "}
            <Button variant="link" onClick={() => void load()}>
              Try again
            </Button>
          </Alert>
        ) : (
          <Loading label="Loading your family…" />
        )}
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="family-heading">
      <h2 id="family-heading" className="section-title">
        The {data.family.name} family
      </h2>
      <Alert>{actionError}</Alert>
      <Alert kind="success">{notice}</Alert>
      <ul className="plain">
        {data.adults.map((a) => (
          <li key={a.email}>
            {a.name.trim() || a.email}{" "}
            <span className="muted">{a.you ? "(you)" : `· ${a.email}`}</span>
          </li>
        ))}
        {data.invites.map((i) => (
          <li key={i.id} className="invite-row muted">
            <span>
              {i.email} · {i.state === "expired" ? "invitation expired" : "invited"}
            </span>
            <Button
              variant="link"
              onClick={() => cancel(i.id, i.email)}
              busy={busy === i.id}
              aria-label={`Cancel invitation to ${i.email}`}
            >
              Cancel invitation
            </Button>
          </li>
        ))}
      </ul>
      {data.family.status === "active" ? (
        <form onSubmit={invite} noValidate className="inline-form">
          <Field
            ref={emailInput}
            label="Add another adult to your family"
            hint="Their email. They get their own sign-in, and you share one list of books."
            type="email"
            autoComplete="off"
            error={emailError}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setEmailError("");
            }}
          />
          <Button type="submit" variant="secondary" busy={busy === "invite"} busyLabel="Sending…">
            Send invitation
          </Button>
        </form>
      ) : (
        <p className="muted">
          {data.family.status === "pending"
            ? "Once staff approve your family, you can add another adult here."
            : "Borrowing is paused for your family. Please ask the library staff."}
        </p>
      )}
    </section>
  );
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
  const libraryCount = state.status === "ready" ? state.me.libraries.length : 0;
  const [step, setStep] = useState<"idle" | "blocked" | "code">("idle");
  const [blocked, setBlocked] = useState<{
    books: { title: string }[];
    lastAdmin: boolean;
    lastOwner?: boolean;
  } | null>(null);
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
          lastOwner: e.details.lastOwner === true,
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
            Signs you out everywhere and removes your email and sign-in from{" "}
            {libraryCount > 1 ? `all ${libraryCount} libraries you belong to` : "the library"}{" "}
            straight away. In each library where you're the last parent in your family, the family
            is removed too. Books borrowed in the past stay in the library's counts without your
            name.
          </p>
          <Button variant="secondary" onClick={start} busy={busy} busyLabel="Checking…">
            Delete my account
          </Button>
        </>
      )}
      {step === "blocked" && (
        <div className="stack">
          <Alert kind="info">
            {blocked?.lastOwner ? (
              "You run this site, so your account can't be deleted while you're its only owner."
            ) : blocked?.lastAdmin ? (
              `You're the only admin of ${libraryCount > 1 ? "one of your libraries" : "the library"}. Invite another admin there first (Staff › Families › Staff), then you can delete your account.`
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
