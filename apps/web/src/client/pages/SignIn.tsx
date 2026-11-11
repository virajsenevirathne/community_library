import { WebAuthnAbortService } from "@simplewebauthn/browser";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Alert, Button, Field, Layout } from "../components.tsx";
import {
  authClient,
  forgetTokens,
  isPasskeyCancel,
  joinHeaders,
  passkeyHint,
  passkeysSupported,
} from "../lib/auth.ts";
import { navigate, safeNext, useLocation } from "../lib/router.tsx";
import { useSession } from "../lib/session.tsx";

type Step = "email" | "code" | "passkey";

const TITLES: Record<Step, string> = {
  email: "Sign in",
  code: "Check your email",
  passkey: "Save a passkey?",
};

const RESEND_SECONDS = 30;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignInPage() {
  const { query } = useLocation();
  const next = safeNext(query.get("next"));
  const { state, refresh } = useSession();
  const [step, setStep] = useState<Step>("email");
  // Kept here so "Use a different email" returns with the address still filled in.
  const [email, setEmail] = useState(query.get("email") ?? "");
  const setupNeeded = state.status === "ready" && state.me.setupNeeded;

  const finish = async () => {
    forgetTokens();
    const me = await refresh();
    // `next` is a full address (it may name a library), so it is used as is.
    navigate(me?.setupNeeded ? "/setup" : next, { replace: true, absolute: true });
  };

  const afterCodeSignIn = async () => {
    const me = await refresh();
    if (passkeysSupported() && !me?.user?.hasPasskey && !passkeyHint.declined()) setStep("passkey");
    else await finish();
  };

  return (
    <Layout title={TITLES[step]} focusKey={step}>
      {step === "email" && (
        <EmailStep
          email={email}
          setEmail={setEmail}
          setupNeeded={setupNeeded}
          onSent={() => setStep("code")}
          onPasskey={finish}
        />
      )}
      {step === "code" && (
        <CodeStep email={email} onBack={() => setStep("email")} onSignedIn={afterCodeSignIn} />
      )}
      {step === "passkey" && <PasskeyOffer onDone={finish} />}
    </Layout>
  );
}

function EmailStep(props: {
  email: string;
  setEmail: (email: string) => void;
  setupNeeded: boolean;
  onSent: () => void;
  onPasskey: () => void;
}) {
  const { email, setEmail, setupNeeded, onSent } = props;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"email" | "passkey" | null>(null);
  const onPasskey = useRef(props.onPasskey);
  onPasskey.current = props.onPasskey;
  const passkeyFirst = passkeysSupported() && passkeyHint.used();

  // Let the browser offer saved passkeys right in the email field. Started once,
  // and cancelled when this step closes so no prompt appears over the next one.
  useEffect(() => {
    if (!passkeysSupported() || !PublicKeyCredential.isConditionalMediationAvailable) return;
    let active = true;
    void PublicKeyCredential.isConditionalMediationAvailable().then((ok) => {
      if (!ok || !active) return;
      void authClient.signIn.passkey({ autoFill: true }).then((res) => {
        if (active && res && !res.error) {
          passkeyHint.markUsed();
          onPasskey.current();
        }
      });
    });
    return () => {
      active = false;
      WebAuthnAbortService.cancelCeremony();
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!EMAIL_PATTERN.test(address)) {
      setError("Enter your email address, for example name@example.com.");
      return;
    }
    setError("");
    setBusy("email");
    const res = await authClient.emailOtp.sendVerificationOtp({
      email: address,
      type: "sign-in",
      fetchOptions: { headers: joinHeaders() },
    });
    setBusy(null);
    if (res.error) {
      setError(
        res.error.status === 429
          ? "Too many tries. Please wait a few minutes and try again."
          : "Could not send the code. Please try again.",
      );
      return;
    }
    setEmail(address);
    onSent();
  };

  const signInWithPasskey = async () => {
    setError("");
    setBusy("passkey");
    const res = await authClient.signIn.passkey();
    setBusy(null);
    if (res?.error) {
      if (!isPasskeyCancel(res.error)) {
        setError("That passkey did not work. Try again, or get a code by email.");
      }
      return;
    }
    passkeyHint.markUsed();
    onPasskey.current();
  };

  const passkeyButton = passkeysSupported() && (
    <Button
      variant={passkeyFirst ? "primary" : "secondary"}
      className="btn--block"
      onClick={signInWithPasskey}
      busy={busy === "passkey"}
      busyLabel="Waiting for your passkey…"
    >
      Sign in with a passkey
    </Button>
  );

  return (
    <>
      {new URLSearchParams(window.location.search).get("deleted") === "1" && (
        <Alert kind="success">
          Your account has been deleted. A confirmation email is on its way. You're welcome back any
          time: ask staff for the sign-up link.
        </Alert>
      )}
      {new URLSearchParams(window.location.search).get("email") && (
        <p className="muted">Sign in with the address your invitation was sent to.</p>
      )}
      {setupNeeded ? (
        <Alert kind="info">
          This library is not set up yet. Sign in with your email, then you can set it up.
        </Alert>
      ) : (
        <p className="lead">Sign in to borrow and return books.</p>
      )}
      <Alert>{error}</Alert>
      {passkeyFirst && (
        <>
          {passkeyButton}
          <p className="divider">or get a code by email</p>
        </>
      )}
      <form onSubmit={submit} noValidate>
        <Field
          label="Email"
          type="email"
          name="email"
          autoComplete="username webauthn"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="send"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Button
          type="submit"
          variant={passkeyFirst ? "secondary" : "primary"}
          className="btn--block"
          busy={busy === "email"}
          busyLabel="Sending…"
        >
          Email me a code
        </Button>
      </form>
      {!passkeyFirst && passkeyButton && (
        <>
          <p className="divider">or</p>
          {passkeyButton}
        </>
      )}
      {!setupNeeded && (
        <p className="muted">
          New here? Use the sign-up link or QR code from your daycare to join the library.
        </p>
      )}
    </>
  );
}

function CodeStep(props: { email: string; onBack: () => void; onSignedIn: () => void }) {
  const { email, onBack, onSignedIn } = props;
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"verify" | "resend" | null>(null);
  const [canResend, setCanResend] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    if (canResend) return;
    const timer = setTimeout(() => setCanResend(true), RESEND_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [canResend]);

  const verify = async (value: string) => {
    setBusy("verify");
    setError("");
    setNotice("");
    const res = await authClient.signIn.emailOtp({ email, otp: value });
    setBusy(null);
    if (res.error) {
      setError(
        res.error.status === 429
          ? "Too many tries. Please wait a few minutes, then ask for a new code."
          : "That code did not work. It may have expired after 10 minutes. Check it, or ask for a new one.",
      );
      setCode("");
      input.current?.focus();
      return;
    }
    onSignedIn();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the 6-digit code from the email.");
      input.current?.focus();
      return;
    }
    void verify(code);
  };

  const resend = async () => {
    setNotice("");
    setError("");
    setBusy("resend");
    const res = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
      fetchOptions: { headers: joinHeaders() },
    });
    setBusy(null);
    if (res.error) setError("Could not send a new code. Please wait a minute and try again.");
    else {
      setNotice("A new code is on its way. Use the newest email.");
      setCanResend(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <p className="lead" id="code-sent">
        We've emailed a 6-digit code to <strong>{email}</strong>. It usually arrives within a
        minute.
      </p>
      <p className="muted">
        Nothing yet? Check your spam folder, and that this is the address you gave the library.
      </p>
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>
      <Field
        ref={input}
        label="6-digit code"
        className="code-input"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        enterKeyHint="go"
        describedBy="code-sent"
        invalid={Boolean(error)}
        value={code}
        onChange={(e) => {
          // No maxLength: a pasted "123 456" must keep all six digits.
          const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
          setCode(digits);
          if (error) setError("");
          // Submit as soon as the sixth digit is in (also covers paste and autofill).
          if (digits.length === 6 && !busy) void verify(digits);
        }}
      />
      <Button type="submit" className="btn--block" busy={busy === "verify"} busyLabel="Signing in…">
        Sign in
      </Button>
      <div className="row" style={{ marginTop: "1rem" }}>
        <Button
          variant="link"
          onClick={resend}
          disabled={!canResend}
          busy={busy === "resend"}
          busyLabel="Sending…"
        >
          {canResend ? "Send a new code" : `Send a new code (in ${RESEND_SECONDS}s)`}
        </Button>
        <Button variant="link" onClick={onBack}>
          Use a different email
        </Button>
      </div>
    </form>
  );
}

function PasskeyOffer({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError("");
    const res = await authClient.passkey.addPasskey({ name: deviceName() });
    setBusy(false);
    if (res?.error) {
      if (!isPasskeyCancel(res.error)) {
        setError("The passkey was not saved. You can try again from your account page.");
      }
      return;
    }
    passkeyHint.markUsed();
    onDone();
  };
  const decline = () => {
    passkeyHint.markDeclined();
    onDone();
  };
  return (
    <div className="stack">
      <p className="lead">You're signed in. Next time, skip the email code?</p>
      <p>
        Save a passkey and sign in with Face ID, your fingerprint or your phone's screen lock.
        Nothing about your face or fingerprint is shared with the library.
      </p>
      <Alert>{error}</Alert>
      <Button
        className="btn--block"
        onClick={save}
        busy={busy}
        busyLabel="Waiting for your device…"
      >
        Save a passkey
      </Button>
      <Button variant="secondary" className="btn--block" onClick={decline}>
        Not now
      </Button>
    </div>
  );
}

/** A friendly name for the passkey list, such as "iPhone" or "Mac". */
export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows computer";
  return "This device";
}
