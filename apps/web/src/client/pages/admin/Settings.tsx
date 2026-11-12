import { type FormEvent, useEffect, useRef, useState } from "react";
import { Alert, Button, Field, Layout, Loading } from "../../components.tsx";
import { ApiError, api, errorMessage } from "../../lib/api.ts";
import { formatDate } from "../../lib/copies.ts";
import { useSession } from "../../lib/session.tsx";
import { DataExport } from "./DataExport.tsx";
import { KioskSettings } from "./Kiosks.tsx";

interface Settings {
  loanDays: number;
  maxLoans: number;
  maxExtensions: number;
  timezone: string;
  reminderHour: number;
  remindBeforeDays: number;
  overdueReminderDays: number[];
  staffFlagDays: number;
  closedWeekdays: number[];
  closedDates: string[];
  requireApproval: boolean;
  returnsNeedCheckIn: boolean;
  historyMonths: number;
}

type Form = Settings & { libraryName: string; overdueText: string };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A summary like "Open Monday to Friday" so the closed-days choice is easy to check. */
function openDaysSummary(closed: number[]): string {
  const open = [1, 2, 3, 4, 5, 6, 0].filter((d) => !closed.includes(d));
  if (open.length === 0) return "Closed every day";
  if (open.length === 7) return "Open every day";
  if (open.length === 5 && open.every((d) => d >= 1 && d <= 5)) return "Open Monday to Friday";
  return `Open ${open.map((d) => WEEKDAYS[d]).join(", ")}`;
}

function hourLabel(hour: number) {
  return new Date(2026, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Checks the "1, 7, 14" overdue list. Returns the numbers, or an error message. */
function parseOverdueDays(text: string): number[] | string {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length > 10) return "Enter up to 10 numbers.";
  const numbers = parts.map(Number);
  if (numbers.some((n) => !Number.isInteger(n) || n < 1 || n > 365)) {
    return "Use whole numbers of days from 1 to 365, separated by commas, for example 1, 7, 14.";
  }
  return [...new Set(numbers)].sort((a, b) => a - b);
}

const toForm = (settings: Settings, libraryName: string): Form => ({
  ...settings,
  libraryName,
  overdueText: settings.overdueReminderDays.join(", "),
});

const VISIT_DAY = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeZone: "UTC" });

export function SettingsPage() {
  const { refresh } = useSession();
  const [saved, setSaved] = useState<Form | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [newDate, setNewDate] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  const dirty = form !== null && saved !== null && JSON.stringify(form) !== JSON.stringify(saved);
  const [supportVisits, setSupportVisits] = useState<string[]>([]);

  useEffect(() => {
    api<{ libraryName: string; settings: Settings; supportVisits?: string[] }>("/admin/settings")
      .then((res) => {
        const loaded = toForm(res.settings, res.libraryName);
        setForm(loaded);
        setSaved(loaded);
        setSupportVisits(res.supportVisits ?? []);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (!form) {
    return (
      <Layout title="Settings" back="/admin">
        {error ? <Alert>{error}</Alert> : <Loading />}
      </Layout>
    );
  }

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm({ ...form, [key]: value });
    setNotice("");
  };
  const num = (key: keyof Settings) => (e: { target: { value: string } }) =>
    set(key, (e.target.value === "" ? Number.NaN : Number(e.target.value)) as never);

  /** Focuses the first field with a problem, so it is seen and announced. */
  const focusFirstError = () =>
    requestAnimationFrame(() => {
      const invalid = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      invalid?.focus();
      invalid?.scrollIntoView({ block: "center" });
    });

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setNotice("");
    const overdue = parseOverdueDays(form.overdueText);
    if (typeof overdue === "string") {
      setFieldErrors({ overdueReminderDays: overdue });
      setError("Fix 1 setting below.");
      focusFirstError();
      return;
    }
    if (
      saved &&
      form.historyMonths < saved.historyMonths &&
      !confirm(
        `Forget who borrowed after ${form.historyMonths} months instead of ${saved.historyMonths}? Older history loses the family names right away, and this can't be undone.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setFieldErrors({});
    const { libraryName, overdueText: _text, ...settings } = form;
    try {
      const res = await api<{ settings: Settings; libraryName: string }>("/admin/settings", {
        method: "PATCH",
        body: { ...settings, overdueReminderDays: overdue, libraryName },
      });
      const next = toForm(res.settings, res.libraryName);
      setForm(next);
      setSaved(next);
      setNotice("Settings saved.");
      await refresh();
    } catch (e) {
      const details = e instanceof ApiError ? e.errors : undefined;
      if (details && details.length > 0) {
        setFieldErrors(Object.fromEntries(details.map((d) => [d.field, d.message])));
        setError(`Fix ${details.length} ${details.length === 1 ? "setting" : "settings"} below.`);
        focusFirstError();
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleWeekday = (day: number) =>
    set(
      "closedWeekdays",
      form.closedWeekdays.includes(day)
        ? form.closedWeekdays.filter((d) => d !== day)
        : [...form.closedWeekdays, day],
    );

  const addDate = () => {
    if (newDate && !form.closedDates.includes(newDate)) {
      set("closedDates", [...form.closedDates, newDate].sort());
    }
    setNewDate("");
    dateInput.current?.focus();
  };

  const today = todayIso();
  const upcomingDates = form.closedDates.filter((d) => d >= today);

  return (
    <Layout title="Settings" back="/admin">
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>
      <form ref={formRef} onSubmit={save} noValidate className="settings-form">
        <h2>Library</h2>
        <Field
          label="Library name"
          maxLength={80}
          error={fieldErrors.libraryName}
          value={form.libraryName}
          onChange={(e) => set("libraryName", e.target.value)}
        />
        <p className="muted">
          Timezone: <strong>{form.timezone.replace(/_/g, " ")}</strong>. Due dates and reminder
          times follow it. It was chosen when the library was set up; to change it, ask the person
          who set up this site.
        </p>

        <h2>Borrowing</h2>
        <Field
          label="Loan length (days)"
          type="number"
          inputMode="numeric"
          min={1}
          max={120}
          error={fieldErrors.loanDays}
          value={Number.isNaN(form.loanDays) ? "" : form.loanDays}
          onChange={num("loanDays")}
        />
        <Field
          label="Books per family"
          hint="The most books one family can have out at once."
          type="number"
          inputMode="numeric"
          min={1}
          max={50}
          error={fieldErrors.maxLoans}
          value={Number.isNaN(form.maxLoans) ? "" : form.maxLoans}
          onChange={num("maxLoans")}
        />
        <Field
          label="Extensions per loan"
          hint="How many times a family can tap “Keep longer”. 0 turns it off."
          type="number"
          inputMode="numeric"
          min={0}
          max={10}
          error={fieldErrors.maxExtensions}
          value={Number.isNaN(form.maxExtensions) ? "" : form.maxExtensions}
          onChange={num("maxExtensions")}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={form.requireApproval}
            onChange={(e) => set("requireApproval", e.target.checked)}
          />
          Staff approve new families before they can borrow
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.returnsNeedCheckIn}
            onChange={(e) => set("returnsNeedCheckIn", e.target.checked)}
            aria-describedby="check-in-hint"
          />
          Staff check returned books in
        </label>
        <p className="field__hint" id="check-in-hint" aria-live="polite">
          {form.returnsNeedCheckIn
            ? "When a borrower taps Return, the book shows as handed back. It counts as returned once staff scan it from the returns basket. Scan the basket every day or two: after 3 days an unchecked book counts against the family again."
            : "When a borrower taps Return, the book is returned straight away. Books already handed back can then be returned by their family, or checked in by staff."}
        </p>

        <h2>Opening days</h2>
        <fieldset className="field" aria-describedby="open-days">
          <legend>Days the library is closed</legend>
          <p className="field__hint" id="open-days">
            {openDaysSummary(form.closedWeekdays)}. Books are never due on a closed day, and no
            reminders go out.
          </p>
          <div className="checks">
            {[1, 2, 3, 4, 5, 6, 0].map((day) => (
              <label key={day} className="check">
                <input
                  type="checkbox"
                  checked={form.closedWeekdays.includes(day)}
                  aria-invalid={fieldErrors.closedWeekdays ? true : undefined}
                  onChange={() => toggleWeekday(day)}
                />
                {WEEKDAYS[day]}
              </label>
            ))}
          </div>
          {fieldErrors.closedWeekdays && (
            <p className="field__error" role="alert">
              {fieldErrors.closedWeekdays}
            </p>
          )}
        </fieldset>
        <div className="field">
          <label htmlFor="closed-date">Closed dates (holidays)</label>
          <p className="field__hint">Past dates are tidied away automatically.</p>
          <div className="row">
            <input
              id="closed-date"
              ref={dateInput}
              type="date"
              min={today}
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addDate();
                }
              }}
            />
            <Button variant="secondary" disabled={!newDate} onClick={addDate}>
              Add date
            </Button>
          </div>
          {upcomingDates.length > 0 && (
            <ul className="list" aria-live="polite">
              {upcomingDates.map((date) => (
                <li key={date}>
                  {formatDate(date)} {date.slice(0, 4)}
                  <Button
                    variant="link"
                    aria-label={`Remove ${formatDate(date)}`}
                    onClick={() => {
                      set(
                        "closedDates",
                        form.closedDates.filter((d) => d !== date),
                      );
                      dateInput.current?.focus();
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {fieldErrors.closedDates && <p className="field__error">{fieldErrors.closedDates}</p>}
        </div>

        <h2>Reminder emails</h2>
        <div className="field">
          <label htmlFor="reminder-hour">Send reminders at</label>
          <select
            id="reminder-hour"
            value={form.reminderHour}
            onChange={(e) => set("reminderHour", Number(e.target.value))}
          >
            {Array.from({ length: 24 }, (_, hour) => hour).map((hour) => (
              <option key={hour} value={hour}>
                {hourLabel(hour)}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Heads-up before the due date (days)"
          hint="0 turns the heads-up off."
          type="number"
          inputMode="numeric"
          min={0}
          max={14}
          error={fieldErrors.remindBeforeDays}
          value={Number.isNaN(form.remindBeforeDays) ? "" : form.remindBeforeDays}
          onChange={num("remindBeforeDays")}
        />
        <Field
          label="Overdue reminders (days late)"
          hint="Send a reminder when a book is this many days late. Separate with commas, for example 1, 7, 14."
          inputMode="text"
          autoComplete="off"
          error={fieldErrors.overdueReminderDays}
          value={form.overdueText}
          onChange={(e) => set("overdueText", e.target.value)}
        />
        <Field
          label="Flag to staff after (days late)"
          hint="Late books show as “Follow up” on the dashboard and in the Monday summary."
          type="number"
          inputMode="numeric"
          min={1}
          max={365}
          error={fieldErrors.staffFlagDays}
          value={Number.isNaN(form.staffFlagDays) ? "" : form.staffFlagDays}
          onChange={num("staffFlagDays")}
        />

        <h2>Privacy</h2>
        <Field
          label="Forget who borrowed a book after (months)"
          hint="After this, returned loans are kept only as counts, without the family."
          type="number"
          inputMode="numeric"
          min={1}
          max={120}
          error={fieldErrors.historyMonths}
          value={Number.isNaN(form.historyMonths) ? "" : form.historyMonths}
          onChange={num("historyMonths")}
        />

        <div className="sticky-actions">
          {dirty && <span className="muted">You have unsaved changes.</span>}
          <Button type="submit" busy={busy} busyLabel="Saving…">
            Save settings
          </Button>
        </div>
      </form>
      <KioskSettings />
      <DataExport />
      <section className="card settings-support" aria-labelledby="support-heading">
        <h2 id="support-heading" className="section-title">
          Site support visits
        </h2>
        {supportVisits.length === 0 ? (
          <p className="muted">
            The person who runs this site hasn't opened your library. If they do, to help with a
            problem, each day's visit is listed here.
          </p>
        ) : (
          <>
            <p className="muted">
              Days the person who runs this site opened your library to help (latest first):
            </p>
            <ul>
              {supportVisits.map((day) => (
                <li key={day}>{VISIT_DAY.format(new Date(`${day}T12:00:00Z`))}</li>
              ))}
            </ul>
          </>
        )}
      </section>
    </Layout>
  );
}
