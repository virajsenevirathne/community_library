import { useEffect, useState } from "react";
import { JoinShareButtons } from "../../components/JoinShare.tsx";
import { Alert, Layout, Loading } from "../../components.tsx";
import { Icon, type IconName } from "../../icons.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { Link } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";

interface Dashboard {
  booksOut: number;
  overdue: number;
  needsStaff: number;
  dueThisWeek: number;
  reportedFound: number;
  waitingForCheckIn?: number;
  returnsNeedCheckIn?: boolean;
  mostBorrowed: { id: string; title: string; times: number }[];
  neverBorrowed: { total: number; titles: { id: string; title: string }[] };
  /** Null until there are enough borrows to say anything. */
  borrowSpeed: {
    borrows: number;
    withinGoal: number;
    p90Seconds: number;
    goalSeconds: number;
  } | null;
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

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Stat(props: { value: number; label: string; href: string; alert?: boolean }) {
  return (
    <li className={`stat${props.alert && props.value > 0 ? " stat--alert" : ""}`}>
      <Link href={props.href}>
        <span className="stat__value">{props.value}</span>
        <span className="stat__label">{props.label}</span>
      </Link>
    </li>
  );
}

function Tile(props: {
  href: string;
  icon: IconName;
  title: string;
  detail: string;
  primary?: boolean;
}) {
  return (
    <li>
      <Link href={props.href} className={`tile${props.primary ? " tile--primary" : ""}`}>
        <span className="tile__icon">
          <Icon name={props.icon} />
        </span>
        <span className="tile__text">
          <strong>{props.title}</strong>
          <span>{props.detail}</span>
        </span>
      </Link>
    </li>
  );
}

/** A new library's first jobs, ticked off as they're done. */
function GetStarted({ counts }: { counts: NonNullable<Dashboard["counts"]> }) {
  const steps = [
    {
      done: counts.titles > 0,
      href: "/admin/add",
      text: "Add your books: scan each barcode, or type the title.",
    },
    {
      done: counts.titles > 0 && counts.needLabels === 0,
      href: "/admin/labels",
      text: "Print the QR stickers and put one inside each cover.",
    },
    {
      done: counts.families > 0,
      href: "/admin/families",
      text: "Share the sign-up link or print the poster, so families can join.",
    },
    {
      done: false,
      href: "/admin/settings",
      text: "Check loan length and the days you're closed.",
    },
  ];
  return (
    <section className="card get-started" aria-labelledby="get-started-heading">
      <h2 id="get-started-heading" className="section-title">
        Get started
      </h2>
      <ol className="checklist">
        {steps.map((step, i) => (
          <li key={step.href} className={step.done ? "checklist__done" : undefined}>
            <span className="checklist__mark" aria-hidden="true">
              {step.done ? "✓" : i + 1}
            </span>
            <Link href={step.href} className="checklist__link">
              {step.text}
            </Link>
            {step.done && <span className="visually-hidden"> (done)</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Sharing the sign-up link, straight from the dashboard: the phone's share
 * sheet, the QR code as a picture, or a poster. The link itself is made (and
 * replaced) on the Families page.
 */
function InviteFamilies({ isAdmin }: { isAdmin: boolean }) {
  const { state } = useSession();
  const libraryName = (state.status === "ready" && state.me.library?.name) || "the library";
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ joinUrl: string | null }>("/admin/join-link")
      .then((res) => setUrl(res.joinUrl))
      .catch(() => setUrl(undefined));
  }, []);
  if (url === undefined || (url === null && !isAdmin)) return null;
  return (
    <section className="card stack" aria-labelledby="invite-heading">
      <h2 id="invite-heading" className="section-title">
        Invite families
      </h2>
      {url ? (
        <>
          <p className="muted">
            Families join with your sign-up link: share it in a group chat or newsletter, or put the
            QR code up by the shelf.
          </p>
          <Alert>{error}</Alert>
          <JoinShareButtons url={url} libraryName={libraryName} onError={setError} />
        </>
      ) : (
        <p>
          Families join with a sign-up link.{" "}
          <Link href="/admin/families#join-card">Create one on the Families page</Link>.
        </p>
      )}
    </section>
  );
}

/** Staff home: what needs attention first, the day's jobs, then the rest of the library. */
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

  const counts = data?.counts;
  const showCheckIn = data && (data.returnsNeedCheckIn || (data.waitingForCheckIn ?? 0) > 0);

  return (
    <Layout title="Library dashboard" width="wide">
      <Alert>{error}</Alert>
      {!data && !error && <Loading label="Loading the dashboard…" />}
      {data && (
        <div className="split">
          <div>
            {counts && counts.pendingFamilies > 0 && (
              <Alert kind="info">
                {plural(counts.pendingFamilies, "family is", "families are")} waiting for approval.{" "}
                <Link href="/admin/families">Review them</Link>
              </Alert>
            )}
            {data.reminders.stale && (
              <Alert kind="warning">
                Reminder emails have paused, so families aren't getting due-date emails right now.{" "}
                {isAdmin
                  ? "Please ask whoever set up this site to check its scheduled reminders."
                  : "Please let the library admin know."}
                {isAdmin && (
                  <details>
                    <summary>Technical details</summary>
                    Check the Worker's Cron Trigger (hourly) in the Cloudflare dashboard.
                    {data.reminders.error && ` Last error: ${data.reminders.error}`}
                  </details>
                )}
              </Alert>
            )}
            {data.email.leftToday !== null && data.email.leftToday < 20 && (
              <Alert kind="warning">
                Only {data.email.leftToday} emails can still be sent today. Reminder emails will go
                out tomorrow; sign-in codes still work.
              </Alert>
            )}

            {counts && (counts.titles === 0 || counts.families === 0) && (
              <GetStarted counts={counts} />
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
                label="to follow up"
                href="/admin/loans?filter=follow-up"
                alert
              />
              {showCheckIn && (
                <Stat
                  value={data.waitingForCheckIn ?? 0}
                  label="to check in"
                  href="/admin/loans?filter=check-in"
                />
              )}
              <Stat
                value={data.dueThisWeek}
                label="due this week"
                href="/admin/loans?filter=due-soon"
              />
              <Stat value={data.booksOut} label="books out" href="/admin/loans" />
            </ul>

            <InviteFamilies isAdmin={isAdmin} />

            <section className="tile-group" aria-labelledby="daily-heading">
              <h2 id="daily-heading">Every day</h2>
              <ul className="tiles">
                <Tile
                  href="/admin/returns"
                  icon="return"
                  title="Check in returns"
                  detail="Scan the books in the returns basket"
                  primary
                />
                <Tile
                  href="/admin/loans"
                  icon="list"
                  title="Loans"
                  detail="Who has what, and late books"
                />
              </ul>
            </section>

            <section className="tile-group" aria-labelledby="library-heading">
              <h2 id="library-heading">Library</h2>
              <ul className="tiles">
                <Tile
                  href="/admin/add"
                  icon="plus"
                  title="Add books"
                  detail="Scan a barcode or type it in"
                />
                <Tile
                  href="/admin/catalog"
                  icon="library"
                  title="Catalog"
                  detail={
                    counts
                      ? `${plural(counts.titles, "book", "books")}, ${plural(counts.copies, "copy", "copies")}`
                      : "Every book and copy"
                  }
                />
                <Tile
                  href="/admin/labels"
                  icon="tag"
                  title="Print labels"
                  detail={
                    counts?.needLabels
                      ? `${plural(counts.needLabels, "copy needs", "copies need")} a label`
                      : "QR stickers for new copies"
                  }
                />
                <Tile
                  href="/admin/families"
                  icon="family"
                  title="Families"
                  detail={
                    counts ? plural(counts.families, "family", "families") : "Invite and approve"
                  }
                />
                {isAdmin && (
                  <Tile
                    href="/admin/settings"
                    icon="settings"
                    title="Settings"
                    detail="Loan length, limits, closed days"
                  />
                )}
              </ul>
            </section>
          </div>

          <aside className="stack">
            <section className="card" aria-labelledby="popular-heading">
              <h2 id="popular-heading" className="section-title">
                Most borrowed
              </h2>
              <p className="muted">Last 90 days</p>
              {data.mostBorrowed.length === 0 ? (
                <p className="muted">Nothing borrowed yet. The favourites will show up here.</p>
              ) : (
                <ol className="count-list">
                  {data.mostBorrowed.map((t) => (
                    <li key={t.id}>
                      <Link href={`/admin/catalog/${t.id}`}>{t.title}</Link>
                      <span className="muted">{plural(t.times, "time", "times")}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {data.neverBorrowed.total > 0 && (
              <section className="card" aria-labelledby="never-heading">
                <h2 id="never-heading" className="section-title">
                  Waiting for a reader
                </h2>
                <p className="muted">
                  {plural(data.neverBorrowed.total, "book has", "books have")} never been borrowed.
                  Try them on a display shelf.
                  {data.neverBorrowed.total > data.neverBorrowed.titles.length &&
                    ` The ${data.neverBorrowed.titles.length} added longest ago:`}
                </p>
                <ul className="count-list">
                  {data.neverBorrowed.titles.map((t) => (
                    <li key={t.id}>
                      <Link href={`/admin/catalog/${t.id}`}>{t.title}</Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.borrowSpeed && (
              <section className="card" aria-labelledby="speed-heading">
                <h2 id="speed-heading" className="section-title">
                  How quickly books go out
                </h2>
                <p className="muted">
                  Last 30 days, {plural(data.borrowSpeed.borrows, "borrow", "borrows")}
                </p>
                <p>
                  9 in 10 borrows took <strong>{data.borrowSpeed.p90Seconds} seconds</strong> or
                  less, from opening the book to “Enjoy the book!”.
                </p>
                <p className="muted">
                  {Math.floor(data.borrowSpeed.withinGoal * 100)}% were done within{" "}
                  {data.borrowSpeed.goalSeconds} seconds; the goal is 90%.
                  {data.borrowSpeed.withinGoal < 0.9 &&
                    " If borrowing feels slow, check the Wi-Fi by the shelf and that stickers aren't worn."}
                </p>
              </section>
            )}
          </aside>
        </div>
      )}
    </Layout>
  );
}
