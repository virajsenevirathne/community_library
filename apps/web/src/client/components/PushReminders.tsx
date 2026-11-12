import { useEffect, useRef, useState } from "react";
import { Alert, Button } from "../components.tsx";
import { api, errorMessage } from "../lib/api.ts";
import {
  claimThisDevice,
  currentSubscription,
  needsHomeScreen,
  pushSupported,
  turnOffPush,
  turnOnPush,
} from "../lib/push.ts";
import { useSession } from "../lib/session.tsx";

/*
 * Notifications for due-date reminders. Offered after a borrow (never on a
 * first visit), and chosen on the Account page: email, notifications, or both.
 */

const DECLINED_KEY = "pushOfferDeclined";

/** Safari on iPhone only offers notifications to a site added to the Home Screen. */
const HOME_SCREEN_HINT =
  "On iPhone or iPad (iOS 16.4 or later), notifications work once Reading Joey is on your Home Screen: open this site in Safari, tap Share, then Add to Home Screen, and open Reading Joey from there.";

function declined(): boolean {
  try {
    return localStorage.getItem(DECLINED_KEY) === "1";
  } catch {
    return false;
  }
}

const RESULTS = {
  on: "Done. Reminders will come to this phone, and by email too. You can change that on your Account page.",
  dismissed: "No problem. You can turn reminders on later from your Account page.",
  denied:
    "Notifications are blocked for this site, so reminders will keep coming by email. To change that, allow notifications for this site in your browser or phone settings, then turn them on from your Account page.",
  failed:
    "This phone couldn't be set up for notifications just now, so reminders will keep coming by email. You can try again from your Account page.",
  no: "OK, we won't ask again. Reminders will keep coming by email.",
} as const;

/** After borrowing: "Get reminders on this phone?" Shown until answered. */
export function PushOffer() {
  const { state, refresh } = useSession();
  const me = state.status === "ready" ? state.me : null;
  const [answer, setAnswer] = useState<keyof typeof RESULTS | null>(null);
  const [busy, setBusy] = useState(false);
  const section = useRef<HTMLElement>(null);
  const show =
    me?.pushKey &&
    me.user &&
    me.user.pushDevices === 0 &&
    !needsHomeScreen() &&
    pushSupported() &&
    Notification.permission === "default" &&
    !declined();
  // Decided once per visit: the offer doesn't vanish while it's being answered.
  const [offered] = useState(Boolean(show));
  // The buttons are replaced by the answer: move focus there, so it's read out.
  useEffect(() => {
    if (answer) section.current?.focus();
  }, [answer]);
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

  return (
    <section
      className="card stack"
      aria-label="Reminders on this phone"
      ref={section}
      tabIndex={-1}
    >
      {answer ? (
        <p>{RESULTS[answer]}</p>
      ) : (
        <>
          <p>
            <strong>Get due-date reminders on this phone?</strong> A notification before a book is
            due, instead of digging through email.
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
  { value: "email", label: "Email", saved: "Reminders will come by email." },
  {
    value: "push",
    label: "Notifications",
    saved: "Reminders will come as notifications, not email.",
  },
  {
    value: "both",
    label: "Both",
    saved: "Reminders will come as notifications and by email.",
  },
] as const;

/** Account › Due-date reminders: where reminders go, and this device's notifications. */
export function RemindersSetting() {
  const { state, refresh } = useSession();
  const me = state.status === "ready" ? state.me : null;
  const [here, setHere] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const devices = me?.user?.pushDevices ?? 0;
  const supported = pushSupported() && !needsHomeScreen();

  useEffect(() => {
    if (!supported) return;
    currentSubscription()
      .then((s) => setHere(s !== null))
      .catch(() => setHere(false));
  }, [supported]);

  // Notifications are on in this browser, but not for the person signed in now
  // (a shared phone, or an earlier save failed): claim them quietly.
  useEffect(() => {
    if (here && devices === 0) {
      void claimThisDevice().then(async (ok) => {
        if (ok) await refresh();
        else setHere(false);
      });
    }
  }, [here, devices, refresh]);

  // Reminders are about books a family has out.
  if (!me?.user || !me.pushKey || !me.membership?.family) return null;
  const notifyBy = me.user.notifyBy;

  const choose = async (choice: (typeof CHOICES)[number]) => {
    setBusy(choice.value);
    setError("");
    setNotice("");
    try {
      await api("/account/notify-by", { method: "PUT", body: { notifyBy: choice.value } });
      await refresh();
      setNotice(choice.saved);
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
      setNotice("Notifications are on for this device. Reminders will come here and by email.");
    } else if (result === "dismissed") {
      setNotice("Notifications weren't turned on. Try again whenever you like.");
    } else {
      setError(
        result === "denied"
          ? "Notifications are blocked for this site. Allow them in your browser or phone settings, then try again."
          : "This device couldn't be set up for notifications just now. Please try again in a moment.",
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
      <fieldset className="field" aria-describedby={devices === 0 ? "reminders-why" : undefined}>
        <legend>Send my reminders by</legend>
        {CHOICES.map((c) => (
          <label key={c.value} className="check">
            <input
              type="radio"
              name="notify-by"
              value={c.value}
              checked={notifyBy === c.value}
              // Unavailable without a device; while saving, a press is simply ignored.
              disabled={c.value !== "email" && devices === 0}
              aria-disabled={busy !== null || undefined}
              onChange={() => {
                if (busy === null) void choose(c);
              }}
            />
            {c.label}
          </label>
        ))}
      </fieldset>
      {!supported ? (
        <p className="muted" id="reminders-why">
          {needsHomeScreen()
            ? HOME_SCREEN_HINT
            : "This browser can't show notifications, so reminders come by email."}
        </p>
      ) : (
        <>
          {devices === 0 && (
            <p className="muted" id="reminders-why">
              To get reminders as notifications, turn them on for this device first.
            </p>
          )}
          {here === null ? (
            // Separate buttons (keys), so one doesn't fade into the other's colours.
            <Button key="checking" variant="secondary" disabled>
              Checking this device…
            </Button>
          ) : here ? (
            <Button
              key="off"
              variant="secondary"
              onClick={turnOff}
              busy={busy === "off"}
              busyLabel="Turning off…"
            >
              Turn off notifications on this device
            </Button>
          ) : (
            <Button key="on" onClick={turnOn} busy={busy === "on"} busyLabel="Turning on…">
              Turn on notifications on this device
            </Button>
          )}
        </>
      )}
    </section>
  );
}
