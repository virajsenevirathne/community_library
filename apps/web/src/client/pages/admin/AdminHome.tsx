import { useEffect, useState } from "react";
import { Alert, Layout, Loading } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { Link } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";

interface Dashboard {
  booksOut: number;
  overdue: number;
  needsStaff: number;
  dueThisWeek: number;
  reportedFound: number;
  mostBorrowed: { id: string; title: string; times: number }[];
  counts: {
    titles: number;
    copies: number;
    families: number;
    pendingFamilies: number;
    needLabels: number;
  } | null;
  reminders: { lastRun: number | null; stale: boolean; error: string | null };
  email: { leftToday: number | null; dailyLimit: number };
}

function Stat({
  value,
  label,
  href,
  alert,
}: {
  value: number;
  label: string;
  href?: string;
  alert?: boolean;
}) {
  const body = (
    <>
      <span className={`stat__value${alert && value > 0 ? " late" : ""}`}>{value}</span>
      <span className="stat__label">{label}</span>
    </>
  );
  return <li className="stat">{href ? <Link href={href}>{body}</Link> : body}</li>;
}

/** Staff home: who has what, what is late, and anything that needs attention. */
export function AdminHomePage() {
  const { state } = useSession();
  const isAdmin = state.status === "ready" && state.me.membership?.role === "admin";
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    api<Dashboard>("/admin/dashboard", { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        const message = errorMessage(e);
        if (message) setError(message);
      });
    return () => controller.abort();
  }, []);

  return (
    <Layout title="Library dashboard">
      <Alert>{error}</Alert>
      {!data && !error && <Loading label="Loading the dashboard…" />}
      {data && (
        <>
          {data.counts && data.counts.pendingFamilies > 0 && (
            <Alert kind="info">
              {data.counts.pendingFamilies}{" "}
              {data.counts.pendingFamilies === 1 ? "family is" : "families are"} waiting for
              approval. <Link href="/admin/families">Review them</Link>
            </Alert>
          )}
          {data.reminders.stale && (
            <Alert>
              Reminder emails have stopped, so families aren't being reminded about due books.{" "}
              {isAdmin
                ? "Check that the site's scheduled job (Cron Trigger) is set up."
                : "Please let the library admin know."}
              {isAdmin && data.reminders.error && (
                <details>
                  <summary>Technical details</summary>
                  {data.reminders.error}
                </details>
              )}
            </Alert>
          )}
          {data.email.leftToday !== null && data.email.leftToday < 20 && (
            <Alert kind="info">
              Only {data.email.leftToday} emails can still be sent today. Reminder emails will go
              out tomorrow; sign-in codes still work.
            </Alert>
          )}
          <ul className="stats" aria-label="Library summary">
            {data.reportedFound > 0 && (
              <Stat
                value={data.reportedFound}
                label="reported found"
                href="/admin/loans?filter=found"
              />
            )}
            <Stat value={data.overdue} label="overdue" href="/admin/loans?filter=overdue" alert />
            <Stat
              value={data.needsStaff}
              label="need following up"
              href="/admin/loans?filter=follow-up"
              alert
            />
            <Stat value={data.dueThisWeek} label="due this week" />
            <Stat value={data.booksOut} label="books out" href="/admin/loans" />
          </ul>
        </>
      )}

      <h2>What do you want to do?</h2>
      <ul className="tiles">
        <li>
          <Link href="/admin/returns" className="tile">
            <strong>Check in returns</strong>
            <span>Scan the books in the returns basket</span>
          </Link>
        </li>
        <li>
          <Link href="/admin/loans" className="tile">
            <strong>Loans</strong>
            <span>Every book that's out, late books, reminders</span>
          </Link>
        </li>
        <li>
          <Link href="/admin/add" className="tile">
            <strong>Add books</strong>
            <span>Scan a barcode or type the details</span>
          </Link>
        </li>
        <li>
          <Link href="/admin/catalog" className="tile">
            <strong>Catalog</strong>
            <span>
              {data?.counts
                ? `${data.counts.titles} ${data.counts.titles === 1 ? "book" : "books"}, ${data.counts.copies} ${data.counts.copies === 1 ? "copy" : "copies"}`
                : "Every book and copy"}
            </span>
          </Link>
        </li>
        <li>
          <Link href="/admin/labels" className="tile">
            <strong>Print labels</strong>
            <span>
              {data?.counts?.needLabels
                ? `${data.counts.needLabels} ${data.counts.needLabels === 1 ? "copy needs" : "copies need"} a label`
                : "QR stickers for new copies"}
            </span>
          </Link>
        </li>
        <li>
          <Link href="/admin/families" className="tile">
            <strong>Families</strong>
            <span>
              {data?.counts
                ? `${data.counts.families} ${data.counts.families === 1 ? "family" : "families"}`
                : "Invite, approve, remove"}
            </span>
          </Link>
        </li>
        {isAdmin && (
          <li>
            <Link href="/admin/settings" className="tile">
              <strong>Settings</strong>
              <span>Loan length, limits, reminders, closed days</span>
            </Link>
          </li>
        )}
      </ul>

      {data && data.mostBorrowed.length > 0 && (
        <>
          <h2>Most borrowed (last 90 days)</h2>
          <ol>
            {data.mostBorrowed.map((t) => (
              <li key={t.id}>
                <Link href={`/admin/catalog/${t.id}`}>{t.title}</Link>{" "}
                <span className="muted">
                  · {t.times} {t.times === 1 ? "time" : "times"}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </Layout>
  );
}
