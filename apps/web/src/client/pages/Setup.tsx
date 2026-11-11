import { type FormEvent, useMemo, useRef, useState } from "react";
import { Alert, Button, Field, Layout } from "../components.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { navigate } from "../lib/router.tsx";
import { useSession } from "../lib/session.tsx";

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timezoneList(current: string): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const zones = intl.supportedValuesOf?.("timeZone") ?? [];
  return zones.includes(current) ? zones : [current, ...zones];
}

type Errors = Partial<Record<"setupCode" | "libraryName", string>>;

/** First run: name the library, pick its timezone, and become its admin. */
export function SetupPage() {
  const { state, refresh } = useSession();
  const codeRequired = state.status === "ready" && state.me.setupCodeRequired === true;
  const deviceZone = useMemo(browserTimezone, []);
  const [form, setForm] = useState({
    setupCode: "",
    libraryName: "",
    timezone: deviceZone,
    familyName: "",
  });
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const zones = useMemo(() => timezoneList(deviceZone), [deviceZone]);
  const codeInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const alertBox = useRef<HTMLDivElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: Errors = {};
    if (codeRequired && !form.setupCode.trim()) found.setupCode = "Enter the setup code.";
    if (!form.libraryName.trim()) found.libraryName = "Give the library a name.";
    setErrors(found);
    if (found.setupCode) return codeInput.current?.focus();
    if (found.libraryName) return nameInput.current?.focus();

    setBusy(true);
    setError("");
    try {
      await api("/setup", {
        body: {
          setupCode: form.setupCode.trim() || undefined,
          libraryName: form.libraryName,
          timezone: form.timezone,
          familyName: form.familyName.trim() || undefined,
        },
      });
      await refresh();
      navigate("/", { replace: true });
    } catch (e) {
      setError(errorMessage(e));
      // The message is at the top of a long form: bring it into view.
      requestAnimationFrame(() => alertBox.current?.scrollIntoView({ block: "center" }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Layout title="Set up your library">
      <p className="lead">
        This takes a minute. You'll be the library's admin, and can invite other staff later.
      </p>
      <form onSubmit={submit} noValidate>
        <div ref={alertBox}>
          <Alert>{error}</Alert>
        </div>
        {codeRequired && (
          <Field
            ref={codeInput}
            label="Setup code"
            hint="Ask the person who put this site online. They chose it when deploying."
            autoComplete="off"
            required
            error={errors.setupCode}
            value={form.setupCode}
            onChange={(e) => setForm({ ...form, setupCode: e.target.value })}
          />
        )}
        <Field
          ref={nameInput}
          label="Library name"
          hint="Parents see this on every page and email, for example “Little Owls Book Corner”."
          maxLength={80}
          autoComplete="off"
          required
          error={errors.libraryName}
          value={form.libraryName}
          onChange={(e) => setForm({ ...form, libraryName: e.target.value })}
        />
        <div className="field">
          <label htmlFor="timezone">Timezone</label>
          <p className="field__hint" id="timezone-hint">
            Due dates and reminder emails follow this. Your device uses{" "}
            <strong>{deviceZone.replace(/_/g, " ")}</strong>.
          </p>
          <select
            id="timezone"
            aria-describedby="timezone-hint"
            value={form.timezone}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Your family name (optional)"
          hint="Fill this in if you'll also borrow books as a parent."
          maxLength={60}
          autoComplete="family-name"
          value={form.familyName}
          onChange={(e) => setForm({ ...form, familyName: e.target.value })}
        />
        <Button type="submit" className="btn--block" busy={busy} busyLabel="Creating…">
          Create the library
        </Button>
      </form>
    </Layout>
  );
}
