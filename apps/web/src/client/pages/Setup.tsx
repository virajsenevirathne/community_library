import { type FormEvent, useRef, useState } from "react";
import { Alert, Button, Field, Layout } from "../components.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { navigate } from "../lib/router.tsx";
import { useSession } from "../lib/session.tsx";

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function timezoneList(current: string): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const zones = intl.supportedValuesOf?.("timeZone") ?? [];
  return zones.includes(current) ? zones : [current, ...zones];
}

/** First run: the first person through becomes the site's owner. */
export function SetupPage() {
  const { state, refresh } = useSession();
  const codeRequired = state.status === "ready" && state.me.setupCodeRequired === true;
  const [setupCode, setSetupCode] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (codeRequired && !setupCode.trim()) {
      setFieldError("Enter the setup code.");
      codeInput.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/setup", { body: { setupCode: setupCode.trim() || undefined } });
      await refresh();
      navigate("/owner", { replace: true });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Layout title="Set up this site" siteWide>
      <p className="lead">
        You'll run this site: you create a library for each group and invite its admin, who sets it
        up from there.
      </p>
      <form onSubmit={submit} noValidate className="stack">
        <Alert>{error}</Alert>
        {codeRequired && (
          <Field
            ref={codeInput}
            label="Setup code"
            hint="Chosen when the site was put online (the SETUP_CODE secret)."
            autoComplete="off"
            required
            error={fieldError}
            value={setupCode}
            onChange={(e) => {
              setSetupCode(e.target.value);
              setFieldError("");
            }}
          />
        )}
        <Button type="submit" className="btn--block" busy={busy} busyLabel="Setting up…">
          Become the site owner
        </Button>
      </form>
    </Layout>
  );
}
