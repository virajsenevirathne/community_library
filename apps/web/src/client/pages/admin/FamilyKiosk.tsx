import { type FormEvent, useEffect, useRef, useState } from "react";
import { Alert, Button, Field } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";

/*
 * Kiosk codes on the Families page: each adult's 6-digit code for the kiosk
 * tablet, adults without email (a grandparent, a nanny), and families with
 * no email at all. A code is shown once, when it's made, to read out or
 * write down.
 */

export interface KioskPerson {
  id: string;
  /** Set for adults who sign in with email. */
  userId: string | null;
  name: string;
  hasCode: boolean;
}

interface FamilyLike {
  id: string;
  name: string;
  adults: { userId: string; name: string; email: string }[];
  kioskPeople: KioskPerson[];
}

export interface KioskNotify {
  success: (message: string) => Promise<void>;
  error: (message: string) => void;
  /** Reloads the list without a message, so focus can stay on a new code. */
  reload: () => Promise<void>;
}

/** A code, shown once, with what to do with it. */
function ShownCode({ name, code, onHide }: { name: string; code: string; onHide: () => void }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="kiosk-code">
      <p className="kiosk-code__digits" ref={ref} tabIndex={-1}>
        <span className="visually-hidden">{name}'s kiosk code is </span>
        {code.split("").join(" ")}
      </p>
      <p>
        {name}'s kiosk code. Read it out or write it down for them: it won't be shown again. If it's
        lost, make a new one.
      </p>
      <Button variant="secondary" onClick={onHide}>
        Hide the code
      </Button>
    </div>
  );
}

/** Inside a family's card: everyone's kiosk codes, and adding someone without email. */
export function FamilyKiosk({ family, notify }: { family: FamilyLike; notify: KioskNotify }) {
  const [shown, setShown] = useState<{ name: string; code: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [nameError, setNameError] = useState("");

  const byUser = new Map(family.kioskPeople.filter((k) => k.userId).map((k) => [k.userId, k]));
  const rows = [
    ...family.adults.map((a) => ({
      key: `u-${a.userId}`,
      name: a.name.trim() || a.email,
      userId: a.userId,
      person: byUser.get(a.userId) ?? null,
    })),
    ...family.kioskPeople
      .filter((k) => !k.userId)
      .map((k) => ({ key: k.id, name: k.name, userId: null, person: k })),
  ];

  const makeCode = async (key: string, name: string, request: () => Promise<{ code: string }>) => {
    setBusy(key);
    try {
      const res = await request();
      setShown({ name, code: res.code });
      await notify.reload();
    } catch (e) {
      notify.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const run = async (key: string, request: () => Promise<unknown>, message: string) => {
    setBusy(key);
    try {
      await request();
      setShown(null);
      await notify.success(message);
    } catch (e) {
      notify.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!firstName.trim()) {
      setNameError("Type their first name.");
      return;
    }
    setNameError("");
    const name = firstName.trim();
    setBusy("add");
    try {
      const res = await api<{ code: string }>(`/admin/families/${family.id}/kiosk-people`, {
        body: { firstName: name },
      });
      setAdding(false);
      setFirstName("");
      setShown({ name, code: res.code });
      await notify.reload();
    } catch (e) {
      setNameError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      <h3>Kiosk codes</h3>
      {shown && <ShownCode name={shown.name} code={shown.code} onHide={() => setShown(null)} />}
      <ul className="plain">
        {rows.map((row) => (
          <li key={row.key} className="staff-row">
            <span>
              {row.name}
              {row.userId === null && <span className="muted"> · no email</span>}
              <span className="muted">
                {" "}
                · {row.person?.hasCode ? "has a kiosk code" : "no kiosk code"}
              </span>
            </span>
            <span className="row">
              <Button
                variant="link"
                busy={busy === `code-${row.key}`}
                busyLabel="Making…"
                onClick={() =>
                  makeCode(`code-${row.key}`, row.name, () =>
                    row.person
                      ? api<{ code: string }>(`/admin/kiosk-people/${row.person.id}/renew`, {
                          body: {},
                        })
                      : api<{ code: string }>(`/admin/families/${family.id}/kiosk-people`, {
                          body: { userId: row.userId },
                        }),
                  )
                }
                aria-label={
                  row.person?.hasCode
                    ? `Make a new code for ${row.name}`
                    : `Give ${row.name} a code`
                }
              >
                {row.person?.hasCode ? "New code" : "Give a code"}
              </Button>
              {row.person?.hasCode && (
                <Button
                  variant="link"
                  busy={busy === `off-${row.key}`}
                  onClick={() =>
                    run(
                      `off-${row.key}`,
                      () => api(`/admin/kiosk-people/${row.person?.id}/off`, { body: {} }),
                      `${row.name}'s kiosk code is turned off.`,
                    )
                  }
                  aria-label={`Turn off ${row.name}'s code`}
                >
                  Turn off
                </Button>
              )}
              {row.userId === null && row.person && (
                <Button
                  variant="link"
                  busy={busy === `remove-${row.key}`}
                  onClick={() =>
                    run(
                      `remove-${row.key}`,
                      () => api(`/admin/kiosk-people/${row.person?.id}`, { method: "DELETE" }),
                      `${row.name} is no longer in the ${family.name} family.`,
                    )
                  }
                  aria-label={`Remove ${row.name} from the family`}
                >
                  Remove
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {adding ? (
        <form onSubmit={add} noValidate className="inline-form">
          <Field
            label="First name of someone without email"
            hint="A grandparent or a nanny, for example. They borrow at the kiosk with their code."
            autoComplete="off"
            autoFocus
            maxLength={40}
            error={nameError}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
          />
          <Button type="submit" busy={busy === "add"} busyLabel="Adding…">
            Add and make a code
          </Button>
          <Button variant="secondary" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)}>
          Add someone without email
        </Button>
      )}
    </div>
  );
}

/** A family with no email at all: its first adult borrows at the kiosk with a code. */
export function NoEmailFamilyCard({ notify }: { notify: KioskNotify }) {
  const [open, setOpen] = useState(false);
  const [familyName, setFamilyName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [errors, setErrors] = useState<{ family?: string; first?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ name: string; code: string } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = {
      ...(familyName.trim() ? {} : { family: "Type the family name." }),
      ...(firstName.trim() ? {} : { first: "Type the adult's first name." }),
    };
    setErrors(next);
    if (next.family || next.first) return;
    setBusy(true);
    try {
      const res = await api<{ code: string }>("/admin/families/kiosk-only", {
        body: { familyName: familyName.trim(), firstName: firstName.trim() },
      });
      setShown({ name: firstName.trim(), code: res.code });
      setFamilyName("");
      setFirstName("");
      setOpen(false);
      await notify.reload();
    } catch (e) {
      setErrors({ form: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="no-email-heading">
      <h2 id="no-email-heading" className="section-title">
        Families without email
      </h2>
      <p className="muted">
        For a family that won't use email: they borrow at the kiosk with a code. They get no
        reminder emails, so follow up their late books from Loans.
      </p>
      {shown && <ShownCode name={shown.name} code={shown.code} onHide={() => setShown(null)} />}
      {open ? (
        <form onSubmit={submit} noValidate className="stack">
          <Alert>{errors.form}</Alert>
          <Field
            label="Family name"
            autoComplete="off"
            autoFocus
            maxLength={60}
            error={errors.family}
            value={familyName}
            onChange={(e) => setFamilyName(e.target.value)}
          />
          <Field
            label="First name of an adult"
            autoComplete="off"
            maxLength={40}
            error={errors.first}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
          />
          <div className="row">
            <Button type="submit" busy={busy} busyLabel="Adding…">
              Add the family and make a code
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Add a family without email
        </Button>
      )}
    </section>
  );
}
