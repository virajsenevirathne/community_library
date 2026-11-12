import { useEffect, useState } from "react";
import { Alert, Button } from "../components.tsx";
import { api, errorMessage } from "../lib/api.ts";
import {
  currentSubscription,
  needsHomeScreen,
  pushSupported,
  turnOffPush,
  turnOnPush,
} from "../lib/push.ts";
import { useSession } from "../lib/session.tsx";

/*
 * Phone notifications for due-date reminders. Offered after a borrow (never
 * on a first visit), and chosen on the Account page: email, phone, or both.
 */

const DECLINED_KEY = "pushOfferDeclined";

function declined(): boolean {
  try {
    return localStorage.getItem(DECLINED_KEY) === "1";
  } catch {
    return false;
  }
}

/** After borrowing: "Get reminders on this phone?" Shown once, until answered. */
export function PushOffer() {
  const { state, refresh } = useSession();
  const me = state.status === "ready" ? state.me : null;
  const [answer, setAnswer] = useState<"on" | "no" | "denied" | "failed" | null>(null);
  const [busy, setBusy] = useState(false);
  const show =
    me?.pushKey &&
    me.user &&
    me.user.pushDevices === 0 &&
    pushSupported() &&
    !needsHomeScreen() &&
    Notification.permission === "default" &&
    !declined();
  // Decided once per visit: the offer doesn't vanish while it's being answered.
  const [offered] = useState(Boolean(show));
  if (!offered || !me?.pushKey) return null;

  const yes = async () => {
    setBusy(true);
    const result = await turnOnPush(me.pushKey ?? "");
    setAnswer(result);
    setBusy(false);
    if (result === "on") await refresh();
  };
  const no = () => {
    try {
      localStorage.setItem(DECLINED_KEY, "1");
    } catch {
      // Private mode: it may be offered again next time.
    }
    setAnswer("no");
  };

  if (answer === "no") return null;
  return (
    <section className="card stack" aria-label="Reminders on this phone">
      {answer === "on" ? (
        <Alert kind="success">
          Done. Reminders will come to this phone, and by email too. Change it on your Account page.
        </Alert>
      ) : answer === "denied" ? (
        <Alert kind="info">
          Notifications are blocked for this site, so reminders will keep coming by email. You can
          allow them in your browser's settings.
        </Alert>
      ) : answer === "failed" ? (
        <Alert kind="info">
          This phone couldn't be set up for notifications. Reminders will keep coming by email.
        </Alert>
      ) : (
        <>
          <p>
            <strong>Get due-date reminders on this phone?</strong> A notification a couple of days
            before a book is due, instead of digging through email.
          </p>
          <div className="row">
            <Button onClick={yes} busy={busy} busyLabel="Turning on…">
              Turn on reminders
            </Button>
            <Button variant="secondary" onClick={no}>
              No thanks
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

const CHOICES = [
  { value: "email", label: "Email" },
  { value: "push", label: "Phone notifications" },
  { value: "both", label: "Both" },
] as const;

/** Account › Reminders: where due-date reminders go, and this phone's notifications. */
export function RemindersSetting() {
  const { state, refresh } = useSession();
  const me = state.status === "ready" ? state.me : null;
  const [here, setHere] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void currentSubscription().then((s) => setHere(s !== null));
  }, []);

  if (!me?.user || !me.pushKey) return null;
  const notifyBy = me.user.notifyBy;
  const devices = me.user.pushDevices;

  const choose = async (value: (typeof CHOICES)[number]["value"]) => {
    setBusy(value);
    setError("");
    setNotice("");
    try {
      await api("/account/notify-by", { method: "PUT", body: { notifyBy: value } });
      await refresh();
      setNotice("Saved.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const turnOn = async () => {
    setBusy("on");
    setError("");
    setNotice("");
    const result = await turnOnPush(me.pushKey ?? "");
    if (result === "on") {
      setHere(true);
      await refresh();
      setNotice("Notifications are on for this phone.");
    } else {
      setError(
        result === "denied"
          ? "Notifications are blocked for this site. Allow them in your browser's settings, then try again."
          : "This device couldn't be set up for notifications.",
      );
    }
    setBusy(null);
  };
  const turnOff = async () => {
    setBusy("off");
    setError("");
    setNotice("");
    try {
      await turnOffPush();
      setHere(false);
      await refresh();
      setNotice("Notifications are off for this device.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card stack" aria-labelledby="reminders-heading">
      <h2 id="reminders-heading" className="section-title">
        Due-date reminders
      </h2>
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>
      <fieldset className="field">
        <legend>Send my reminders by</legend>
        {CHOICES.map((c) => (
          <label key={c.value} className="check">
            <input
              type="radio"
              name="notify-by"
              value={c.value}
              checked={notifyBy === c.value}
              disabled={busy !== null || (c.value !== "email" && devices === 0)}
              onChange={() => void choose(c.value)}
            />
            {c.label}
          </label>
        ))}
      </fieldset>
      {devices === 0 && (
        <p className="muted">Turn on notifications on a phone to choose phone reminders.</p>
      )}
      {pushSupported() ? (
        needsHomeScreen() ? (
          <p className="muted">
            On iPhone, notifications work once Reading Joey is on your Home Screen: tap Share, then
            Add to Home Screen, and open it from there.
          </p>
        ) : here ? (
          <Button
            variant="secondary"
            onClick={turnOff}
            busy={busy === "off"}
            busyLabel="Turning off…"
          >
            Turn off notifications on this device
          </Button>
        ) : here === false ? (
          <Button onClick={turnOn} busy={busy === "on"} busyLabel="Turning on…">
            Turn on notifications on this device
          </Button>
        ) : null
      ) : (
        <p className="muted">This browser can't show notifications. Reminders come by email.</p>
      )}
    </section>
  );
}
