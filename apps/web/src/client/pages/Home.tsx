import { useCallback, useEffect, useRef, useState } from "react";
import { KioskPinForm } from "../components/KioskPin.tsx";
import { Alert, Button, Layout, Loading } from "../components.tsx";
import { BookStack } from "../icons.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { formatDate, lateText } from "../lib/copies.ts";
import { Link } from "../lib/router.tsx";
import { isStaff, type Me, useSession } from "../lib/session.tsx";
import { Cover } from "./admin/Cover.tsx";

/** What the person can do right now, which decides what the home page says. */
export function borrowState(
  me: Me,
): "not_member" | "pending" | "paused" | "staff_no_family" | "ok" {
  const membership = me.membership;
  if (!membership) return "not_member";
  const family = membership.family;
  if (!family) return isStaff(me) ? "staff_no_family" : "not_member";
  if (family.status === "pending") return "pending";
  if (family.status === "deactivated") return "paused";
  return "ok";
}

interface MyLoan {
  id: string;
  code: string;
  title: string;
  authors: string;
  coverUrl: string | null;
  dueOn: string;
  overdueDays: number;
  canExtend: boolean;
  handedBack: boolean;
}

/** A parent's home: their family's books, soonest due first. */
export function HomePage() {
  const { state } = useSession();
  if (state.status !== "ready") return null;
  const me = state.me;
  const status = borrowState(me);

  const joined = new URLSearchParams(window.location.search).get("joined") === "1";

  return (
    <Layout title={status === "ok" ? "Your books" : "Welcome"}>
      {joined && status === "ok" && (
        <Alert kind="success">
          Welcome to {me.library?.name ?? "the library"}! You can borrow straight away.
        </Alert>
      )}
      {joined && status === "pending" && (
        <Alert kind="success">
          Thanks for joining. We'll email you as soon as staff approve your family.
        </Alert>
      )}
      {status === "not_member" && (
        <Alert kind="info">
          You're signed in, but you haven't joined this library yet. Ask the library staff for the
          sign-up link or an invite.
        </Alert>
      )}
      {status === "pending" && (
        <>
          <Alert kind="info">
            Your family is waiting for staff approval. You can borrow once they approve it. Ask
            staff if it's taking a while.
          </Alert>
          <p className="lead">
            Once you're approved, scan the QR sticker inside a book's cover to borrow it.
          </p>
        </>
      )}
      {status === "paused" && (
        <Alert kind="info">
          Your family's library membership is paused, so you can't borrow right now. Please ask the
          library staff if you'd like to borrow again.
        </Alert>
      )}
      {status === "staff_no_family" && (
        <Alert kind="info">
          You're signed in as staff. Manage the library from <Link href="/admin">Admin</Link>. To
          borrow for your own family, ask an admin to add you to one.
        </Alert>
      )}
      {status === "ok" && <MyBooks />}
      {/* After the books (and any approval message), so it never hides them. */}
      {joined && (status === "ok" || status === "pending") && (
        <KioskPinPrompt libraryName={me.library?.name ?? "the library"} />
      )}
    </Layout>
  );
}

/** "Due today", "Due tomorrow" or "Due back Friday 21 November", plus lateness. */
function dueText(loan: MyLoan): { text: string; urgent: boolean } {
  if (loan.handedBack)
    return { text: "Handed back: waiting for staff to check it in", urgent: false };
  if (loan.overdueDays > 0) {
    return {
      text: `${lateText(loan.overdueDays)}. Was due ${formatDate(loan.dueOn)}`,
      urgent: true,
    };
  }
  const today = new Date();
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const tomorrow = new Date(today.getTime() + 86_400_000);
  if (loan.dueOn === iso(today)) return { text: "Due back today", urgent: true };
  if (loan.dueOn === iso(tomorrow)) return { text: "Due back tomorrow", urgent: true };
  return { text: `Due back ${formatDate(loan.dueOn)}`, urgent: false };
}

interface Waiting {
  id: string;
  title: string;
  position: number;
  /** We've emailed that a copy is back on the shelf. */
  back: boolean;
}

/** Books the family is on the waiting list for. */
function WaitingFor({
  waiting,
  onChange,
  onLeft,
}: {
  waiting: Waiting[];
  onChange: () => Promise<void>;
  /** Says what happened, in a message that stays when this list is gone. */
  onLeft: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const leave = async (hold: Waiting) => {
    setBusy(hold.id);
    setError("");
    // The row goes: focus the next Leave button, or the list's heading.
    const index = waiting.indexOf(hold);
    const next = waiting[index + 1] ?? waiting[index - 1];
    try {
      await api(`/holds/${hold.id}`, { method: "DELETE" });
      onLeft(`You've left the waiting list for ${hold.title}.`);
      await onChange();
      requestAnimationFrame(() => {
        const target = next
          ? document.getElementById(`leave-${next.id}`)
          : document.querySelector<HTMLElement>("main h1");
        target?.focus();
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-labelledby="waiting-heading">
      <h2 id="waiting-heading">Waiting for</h2>
      <Alert>{error}</Alert>
      <ul className="book-list">
        {waiting.map((hold) => (
          <li key={hold.id} className="book-row book-row--wrap">
            <span className="book-row__text">
              <strong>{hold.title}</strong>
              <span className={hold.back ? "ok" : "muted"}>
                {hold.back
                  ? "We emailed you a copy was back. It isn't kept aside: borrow it soon if it's still there"
                  : hold.position === 1
                    ? "You're first in line"
                    : `${hold.position - 1} ${hold.position === 2 ? "family" : "families"} joined before you`}
              </span>
            </span>
            <Button
              id={`leave-${hold.id}`}
              variant="secondary"
              onClick={() => void leave(hold)}
              busy={busy === hold.id}
              busyLabel="Leaving…"
            >
              Leave<span className="visually-hidden"> the waiting list for {hold.title}</span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MyBooks() {
  const [data, setData] = useState<{
    loans: MyLoan[];
    maxLoans: number;
    waiting: Waiting[];
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Loans extended on this visit: the button is replaced by the new date in the same row.
  const [extended, setExtended] = useState<Record<string, string>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api("/loans/mine"));
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const extend = async (loan: MyLoan) => {
    setBusy(loan.id);
    setRowError((r) => ({ ...r, [loan.id]: "" }));
    try {
      const res = await api<{ dueOn: string }>(`/loans/${loan.id}/extend`, { body: {} });
      setExtended((x) => ({ ...x, [loan.id]: res.dueOn }));
      await load();
    } catch (e) {
      setRowError((r) => ({ ...r, [loan.id]: errorMessage(e) }));
    } finally {
      setBusy(null);
    }
  };

  const overdue = data?.loans.filter((l) => l.overdueDays > 0 && !l.handedBack).length ?? 0;

  return (
    <>
      {error && (
        <Alert>
          {error}{" "}
          <Button variant="link" onClick={() => void load()}>
            Try again
          </Button>
        </Alert>
      )}
      {data === null && !error && <Loading label="Loading your books…" />}
      {data && (
        <>
          {data.loans.length === 0 ? (
            <div className="empty">
              <BookStack className="empty__icon" />
              <p className="empty__title">Nothing borrowed yet</p>
              <ol className="steps">
                <li>Pick a book from the library shelf</li>
                <li>Tap Scan a book, and point the camera at the QR sticker inside the cover</li>
                <li>Tap Borrow</li>
              </ol>
              <Link href="/c" className="btn btn--primary">
                Scan a book
              </Link>
            </div>
          ) : (
            <h2>
              {data.loans.length} of {data.maxLoans} books out
            </h2>
          )}
          {overdue > 0 && (
            <Alert kind="warning">
              {overdue === 1 ? "1 book is" : `${overdue} books are`} overdue. Please bring{" "}
              {overdue === 1 ? "it" : "them"} back soon.
            </Alert>
          )}
          <ul className="book-list">
            {[...data.loans]
              // Books already handed back go last: they're on their way back.
              .sort((a, b) => Number(a.handedBack) - Number(b.handedBack))
              .map((loan) => {
                const due = dueText(loan);
                return (
                  <li key={loan.id} className="book-row book-row--wrap">
                    <Cover url={loan.coverUrl} title={loan.title} size="sm" />
                    <span className="book-row__text">
                      <strong>{loan.title}</strong>
                      <span className={due.urgent ? "late" : "muted"}>{due.text}</span>
                      {extended[loan.id] && (
                        <span className="ok" role="status">
                          Extended to {formatDate(extended[loan.id] ?? "")}
                        </span>
                      )}
                      {rowError[loan.id] && (
                        <span className="late" role="alert">
                          {rowError[loan.id]}
                        </span>
                      )}
                    </span>
                    {loan.canExtend && !extended[loan.id] && (
                      <Button
                        variant="secondary"
                        onClick={() => extend(loan)}
                        busy={busy === loan.id}
                        busyLabel="Extending…"
                        aria-label={`Keep ${loan.title} longer`}
                      >
                        Keep longer
                      </Button>
                    )}
                  </li>
                );
              })}
          </ul>
        </>
      )}
      <Alert kind="success">{notice}</Alert>
      {data && data.waiting.length > 0 && (
        <WaitingFor waiting={data.waiting} onChange={load} onLeft={setNotice} />
      )}
      {data && data.loans.length > 0 && (
        <div className="hint-card">
          <p>To borrow or return a book, scan the QR sticker inside its cover.</p>
          <Link href="/c" className="btn btn--primary btn--block">
            Scan a book
          </Link>
        </div>
      )}
    </>
  );
}

/**
 * Straight after joining, a family's adult can set their kiosk PIN, when the
 * library has a kiosk. Skipped here, it's on the Account page any time.
 */
function KioskPinPrompt({ libraryName }: { libraryName: string }) {
  const [wanted, setWanted] = useState(false);
  const [state, setState] = useState<"open" | "saved" | "later">("open");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    api<{ kioskInUse: boolean; code: unknown; canSet: boolean }>("/family/kiosk-code")
      .then((res) => setWanted(res.kioskInUse && res.canSet && !res.code))
      .catch(() => setWanted(false));
  }, []);
  useEffect(() => {
    if (state !== "open") heading.current?.focus();
  }, [state]);
  if (!wanted) return null;
  return (
    <section className="card stack" aria-labelledby="pin-prompt-heading">
      <h2 id="pin-prompt-heading" className="section-title" ref={heading} tabIndex={-1}>
        {state === "saved" ? "Your PIN is saved" : "Set your kiosk PIN"}
      </h2>
      {state === "open" && (
        <>
          <p className="muted">
            {libraryName} has a kiosk tablet by the shelf. With your own PIN you can borrow there
            without your phone. You can also set it later on your Account page.
          </p>
          <KioskPinForm
            libraryName={libraryName}
            cancelLabel="Not now"
            onSaved={() => setState("saved")}
            onCancel={() => {
              setState("later");
              // So a reload doesn't ask again: that was the welcome, not the page.
              const url = new URL(window.location.href);
              url.searchParams.delete("joined");
              history.replaceState(history.state, "", url);
            }}
          />
        </>
      )}
      {state === "saved" && <p>Type it on the kiosk's keypad when you borrow.</p>}
      {state === "later" && (
        <p>
          No problem. You can set it any time on your <Link href="/account#kiosk-pin">Account</Link>{" "}
          page.
        </p>
      )}
    </section>
  );
}
