import { type FormEvent, useState } from "react";
import { Alert, Button, Layout } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { navigate } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";

/**
 * A new library's first admin lands here: accept the terms and privacy
 * policy, and choose how returns work. Then on to the dashboard.
 */
export function WelcomePage() {
  const { state, refresh } = useSession();
  const name = state.status === "ready" ? (state.me.library?.name ?? "your library") : "";
  const [accepted, setAccepted] = useState(false);
  const [returnsNeedCheckIn, setReturnsNeedCheckIn] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (returnsNeedCheckIn === null) return setError("Choose how returns work.");
    if (!accepted) return setError("Please accept the terms and privacy policy to continue.");
    setBusy(true);
    setError("");
    try {
      await api("/admin/welcome", { body: { acceptTerms: true, returnsNeedCheckIn } });
      await refresh();
      navigate("/admin", { replace: true });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Layout title={`Welcome to ${name}`} focused>
      <p className="lead">Two quick choices and your library is ready to fill with books.</p>
      <form onSubmit={submit} noValidate className="stack">
        <Alert>{error}</Alert>
        <fieldset className="field">
          <legend>When a borrower returns a book</legend>
          <p className="field__hint">You can change this later in Settings.</p>
          <label className="check">
            <input
              type="radio"
              name="returns"
              checked={returnsNeedCheckIn === false}
              onChange={() => setReturnsNeedCheckIn(false)}
            />
            Returned as soon as they tap Return (self-serve). Less work for staff, but a book can
            show as returned while still in someone's bag.
          </label>
          <label className="check">
            <input
              type="radio"
              name="returns"
              checked={returnsNeedCheckIn === true}
              onChange={() => setReturnsNeedCheckIn(true)}
            />
            Staff check it in from the returns basket. More accurate, but staff need to scan the
            basket every day or two.
          </label>
        </fieldset>
        <label className="check">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          <span>
            I accept the{" "}
            <a href="/terms" target="_blank" rel="noopener">
              terms
            </a>{" "}
            and the{" "}
            <a href="/privacy" target="_blank" rel="noopener">
              privacy policy
            </a>{" "}
            on behalf of {name}.
          </span>
        </label>
        <Button type="submit" busy={busy} busyLabel="Saving…">
          Finish setting up
        </Button>
      </form>
    </Layout>
  );
}
