import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Alert, Button, Field, Loading } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { authClient } from "../../lib/auth.ts";
import { libraryBase } from "../../lib/router.tsx";

interface Kiosk {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  on: boolean;
  thisTablet: boolean;
}

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Settings › Kiosk tablets (admins). Turn the tablet in your hand into a
 * kiosk, see each kiosk and when it was last used, and turn one off at once.
 */
export function KioskSettings() {
  const [kiosks, setKiosks] = useState<Kiosk[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("Kiosk tablet");
  const [nameError, setNameError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setKiosks((await api<{ kiosks: Kiosk[] }>("/admin/kiosks")).kiosks);
      setLoadError("");
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setNameError("Give the kiosk a name, such as Front desk tablet.");
      return;
    }
    setNameError("");
    setError("");
    setBusy("create");
    try {
      await api("/admin/kiosks", { body: { name: name.trim() } });
      // A kiosk never keeps a person's sign-in: sign out, then open the kiosk.
      await authClient.signOut();
      window.location.assign(`/${libraryBase() ?? ""}/kiosk`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  const turnOff = async (kiosk: Kiosk) => {
    setBusy(kiosk.id);
    setError("");
    try {
      await api(`/admin/kiosks/${kiosk.id}/off`, { body: {} });
      setConfirmOff(null);
      setNotice(`${kiosk.name} is turned off. It can't borrow or return any more.`);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const on = kiosks?.filter((k) => k.on) ?? [];
  const off = kiosks?.filter((k) => !k.on) ?? [];
  const thisTablet = on.some((k) => k.thisTablet);

  return (
    <section className="card stack" aria-labelledby="kiosk-heading">
      <h2 id="kiosk-heading" className="section-title">
        Kiosk tablets
      </h2>
      <p className="muted">
        A tablet by the shelf where families borrow and return without their phone. Each adult types
        their own 6-digit kiosk code to borrow; returning needs no code.
      </p>
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>
      {loadError ? (
        <Alert>
          {loadError}{" "}
          <Button variant="link" onClick={() => void load()}>
            Try again
          </Button>
        </Alert>
      ) : kiosks === null ? (
        <Loading />
      ) : (
        on.length > 0 && (
          <ul className="plain">
            {on.map((kiosk) => (
              <li key={kiosk.id} className="staff-row">
                <div>
                  <strong>{kiosk.name}</strong>
                  {kiosk.thisTablet && (
                    <>
                      {" "}
                      <span className="badge">This tablet</span>
                    </>
                  )}
                  <br />
                  <span className="muted">
                    {kiosk.lastSeenAt
                      ? `Last used ${WHEN.format(kiosk.lastSeenAt)}`
                      : "Not used yet"}
                  </span>
                </div>
                {confirmOff === kiosk.id ? (
                  <div className="row">
                    <Button
                      variant="danger"
                      busy={busy === kiosk.id}
                      busyLabel="Turning off…"
                      onClick={() => void turnOff(kiosk)}
                    >
                      Turn off {kiosk.name}
                    </Button>
                    <Button variant="secondary" onClick={() => setConfirmOff(null)}>
                      Keep it
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => setConfirmOff(kiosk.id)}
                    aria-label={`Turn off: ${kiosk.name}`}
                  >
                    Turn off
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )
      )}
      {off.length > 0 && (
        <p className="muted">
          Turned off: {off.map((k) => k.name).join(", ")}. A turned-off tablet can be set up again
          below.
        </p>
      )}

      {thisTablet ? (
        <p>
          This tablet is a kiosk. <a href={`/${libraryBase() ?? ""}/kiosk`}>Open the kiosk</a>
        </p>
      ) : (
        <form className="stack" onSubmit={start} noValidate>
          <h3>Use this tablet as a kiosk</h3>
          <Field
            label="Kiosk name"
            hint="So you can tell your kiosks apart, such as Front desk tablet."
            maxLength={40}
            value={name}
            error={nameError}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="muted">
            You'll be signed out on this tablet, and it will open the kiosk. To leave kiosk mode,
            tap Staff in its corner and sign in.
          </p>
          <Button type="submit" busy={busy === "create"} busyLabel="Setting up…">
            Use this tablet as a kiosk
          </Button>
        </form>
      )}
    </section>
  );
}
