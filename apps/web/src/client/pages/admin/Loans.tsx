import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Field, Layout, Loading } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { formatDate, lateText } from "../../lib/copies.ts";
import { Link, useLocation } from "../../lib/router.tsx";
import { useSlashFocus } from "../../lib/useSlashFocus.ts";

interface Loan {
  id: string;
  code: string;
  title: string;
  titleId: string;
  familyId: string | null;
  familyName: string;
  /** Borrowed at the kiosk: who typed their code. */
  kioskName: string | null;
  /** The family can be emailed (families without email borrow only at the kiosk). */
  hasEmail: boolean;
  dueOn: string;
  overdueDays: number;
  needsStaff: boolean;
  reportedFound: boolean;
  handedBack: boolean;
  handedBackDaysAgo: number | null;
  canExtend: boolean;
}

const FILTERS = [
  { id: "all", label: "All out" },
  { id: "overdue", label: "Overdue" },
  { id: "due-soon", label: "Due this week" },
  { id: "follow-up", label: "Follow up" },
  { id: "found", label: "Reported found" },
  { id: "check-in", label: "Waiting for check-in" },
] as const;

const EMPTY: Record<string, string> = {
  all: "No books are out right now.",
  overdue: "Nothing is overdue.",
  "due-soon": "Nothing is due back this week.",
  "follow-up": "No books need following up.",
  found: "No books have been reported found.",
  "check-in": "No books are waiting to be checked in.",
};

type Message = { kind: "success" | "error"; text: string };

/** Every open loan, with what staff can do about each. */
export function LoansPage() {
  const { query } = useLocation();
  const filter = FILTERS.some((f) => f.id === query.get("filter"))
    ? (query.get("filter") as string)
    : "all";
  const [loans, setLoans] = useState<Loan[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  // A message shown on the card that was acted on, or at the top if the card left the list.
  const [cardMessage, setCardMessage] = useState<{ loanId: string } & Message>();
  const [topMessage, setTopMessage] = useState<Message>();
  const topRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  useSlashFocus(searchRef);
  // Loans ticked for "Send reminders". Only loans on screen stay ticked, so
  // nothing hidden by the filter or search is ever emailed.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkStep, setBulkStep] = useState<"idle" | "confirm" | "sending">("idle");
  const selectAllRef = useRef<HTMLInputElement>(null);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ loans: Loan[]; counts: Record<string, number> }>(
        `/admin/loans?filter=${filter}`,
      );
      setLoans(res.loans);
      // Loans that left the list (returned, say) drop out of the selection.
      setSelected((current) => {
        const open = new Set(res.loans.map((l) => l.id));
        return new Set([...current].filter((id) => open.has(id)));
      });
      setCounts(res.counts ?? {});
      setError("");
      return res.loans;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    }
  }, [filter]);
  useEffect(() => {
    setLoans(null);
    setSelected(new Set());
    setBulkStep("idle");
    setCardMessage(undefined);
    setTopMessage(undefined);
    void load();
  }, [load]);

  /** Runs an action, then shows its result on the card (or at the top if the card is gone). */
  const run = async (loan: Loan, request: () => Promise<unknown>, success: string) => {
    setTopMessage(undefined);
    let message: Message;
    try {
      await request();
      message = { kind: "success", text: success };
    } catch (e) {
      message = { kind: "error", text: errorMessage(e) };
    }
    const fresh = await load();
    if (fresh?.some((l) => l.id === loan.id)) {
      setCardMessage({ loanId: loan.id, ...message });
    } else {
      setCardMessage(undefined);
      setTopMessage(message);
      requestAnimationFrame(() => topRef.current?.focus());
    }
  };

  const q = search.trim().toLowerCase();
  const shown =
    loans && q
      ? loans.filter((l) =>
          [l.title, l.familyName, l.code].some((v) => v.toLowerCase().includes(q)),
        )
      : loans;

  // Search narrows what's on screen: drop ticks on loans it hides.
  const shownKey = shown?.map((l) => l.id).join(",") ?? "";
  useEffect(() => {
    const visible = new Set(shownKey.split(","));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [shownKey]);

  const chosen = (shown ?? []).filter((l) => selected.has(l.id));
  const chosenFamilies = new Set(chosen.map((l) => l.familyId ?? l.id)).size;
  const selectable = (shown ?? []).slice(0, MAX_BULK);
  const allChosen = selectable.length > 0 && selectable.every((l) => selected.has(l.id));
  const someChosen = chosen.length > 0 && !allChosen;
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someChosen;
  }, [someChosen]);
  // With nothing ticked there is nothing to confirm.
  useEffect(() => {
    if (chosen.length === 0 && bulkStep === "confirm") setBulkStep("idle");
  }, [chosen.length, bulkStep]);

  // Asking first: focus goes to Cancel, so a stray Enter or double tap sends nothing.
  useEffect(() => {
    if (bulkStep === "confirm") cancelButtonRef.current?.focus();
  }, [bulkStep]);

  const busyBulk = bulkStep !== "idle";
  const toggle = (id: string, on: boolean) => {
    setTopMessage(undefined);
    setSelected((current) => {
      const next = new Set(current);
      if (on && next.size < MAX_BULK) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const toggleAll = (on: boolean) => {
    setTopMessage(undefined);
    setSelected(on ? new Set(selectable.map((l) => l.id)) : new Set());
  };

  const sendReminders = async () => {
    setBulkStep("sending");
    setTopMessage(undefined);
    let message: Message;
    try {
      const res = await api<BulkResult>("/admin/loans/remind", {
        body: { loanIds: chosen.map((l) => l.id) },
      });
      message = bulkMessage(res);
      // Untick what was sent or skipped; what still needs sending stays ticked.
      const settled = new Set(res.sentLoanIds);
      if (res.notYet === 0 && res.failed === 0 && res.deferred === 0) setSelected(new Set());
      else setSelected((current) => new Set([...current].filter((id) => !settled.has(id))));
    } catch (e) {
      message = { kind: "error", text: errorMessage(e) };
    }
    setBulkStep("idle");
    setTopMessage(message);
    requestAnimationFrame(() => topRef.current?.focus());
  };
  const cancelSend = () => {
    setBulkStep("idle");
    requestAnimationFrame(() => sendButtonRef.current?.focus());
  };

  return (
    <Layout title="Loans" width="wide">
      <nav aria-label="Filter loans" className="segmented">
        {FILTERS.map((f) => (
          <Link
            key={f.id}
            href={f.id === "all" ? "/admin/loans" : `/admin/loans?filter=${f.id}`}
            aria-current={filter === f.id ? "page" : undefined}
          >
            {f.label}
            {counts[f.id] !== undefined && (
              <span className="segmented__count">
                <span className="visually-hidden">: </span>
                {counts[f.id]}
              </span>
            )}
          </Link>
        ))}
      </nav>
      <Field
        ref={searchRef}
        label="Find a loan"
        type="search"
        hint="Book title, family name or book code"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <p className="kbd-hint desktop-only">
        Press <kbd>/</kbd> to search from anywhere on this page.
      </p>
      <Alert>{error}</Alert>
      <div ref={topRef} tabIndex={-1}>
        {topMessage && <Alert kind={topMessage.kind}>{topMessage.text}</Alert>}
      </div>
      {shown === null ? (
        !error && <Loading label="Loading loans…" />
      ) : shown.length === 0 ? (
        <div className="empty">
          <p className="empty__title">{q ? "No loans match that search." : EMPTY[filter]}</p>
          <div className="row row--center">
            <Link href="/admin/returns" className="btn btn--secondary">
              Check in returns
            </Link>
            <Link href="/admin/add" className="btn btn--secondary">
              Add books
            </Link>
          </div>
        </div>
      ) : (
        <>
          <p className="muted bulk-hint">Tick loans to email their families a reminder.</p>
          <label className="check select-all">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allChosen}
              disabled={busyBulk}
              onChange={(e) => toggleAll(e.target.checked)}
            />
            {shown.length > MAX_BULK
              ? `Select the first ${MAX_BULK} loans`
              : `Select all ${shown.length} ${shown.length === 1 ? "loan" : "loans"}`}
            {q ? " that match" : ""}
          </label>
          <div className="loan-table">
            <div className="loan-head" aria-hidden="true">
              <span />
              <span>Book</span>
              <span>Family</span>
              <span>Due</span>
              <span />
            </div>
            <ul className="loan-list loan-list--table">
              {shown.map((loan) => (
                <LoanCard
                  key={loan.id}
                  loan={loan}
                  message={cardMessage?.loanId === loan.id ? cardMessage : undefined}
                  onRun={run}
                  selected={selected.has(loan.id)}
                  selectDisabled={busyBulk || (!selected.has(loan.id) && selected.size >= MAX_BULK)}
                  onSelect={(on) => toggle(loan.id, on)}
                />
              ))}
            </ul>
          </div>
        </>
      )}
      {/* Always present, so screen readers hear the count change. */}
      <p className="visually-hidden" role="status">
        {chosen.length > 0 ? `${chosen.length} selected` : ""}
      </p>
      {chosen.length > 0 && (
        <section className="bulk-bar" aria-label="Selected loans">
          {bulkStep === "idle" ? (
            <>
              <p className="bulk-bar__text">
                {chosen.length} selected
                {chosen.length >= MAX_BULK && <span className="muted"> (the most at a time)</span>}
              </p>
              <div className="bulk-bar__actions">
                <Button ref={sendButtonRef} onClick={() => setBulkStep("confirm")}>
                  Send reminders
                </Button>
                <Button variant="secondary" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="bulk-bar__text" id="bulk-question">
                Email {families(chosenFamilies)} about {books(chosen.length)}?{" "}
                <span className="bulk-bar__detail">
                  Each family gets one email listing its books. Books already reminded about today
                  are skipped.
                </span>
              </p>
              <div className="bulk-bar__actions">
                <Button
                  variant="secondary"
                  onClick={cancelSend}
                  disabled={bulkStep === "sending"}
                  aria-describedby="bulk-question"
                  ref={cancelButtonRef}
                >
                  Cancel
                </Button>
                <Button
                  onClick={sendReminders}
                  busy={bulkStep === "sending"}
                  busyLabel="Sending…"
                  aria-describedby="bulk-question"
                >
                  Yes, email {families(chosenFamilies)}
                </Button>
              </div>
            </>
          )}
        </section>
      )}
      <p className="hint-card">
        Checking in a basket of books? <Link href="/admin/returns">Scan them in one go</Link>
      </p>
    </Layout>
  );
}

/** The server accepts this many loans per "Send reminders". */
const MAX_BULK = 100;

interface BulkResult {
  sentLoanIds: string[];
  noEmail: number;
  reminded: number;
  books: number;
  deferred: number;
  failed: number;
  notYet: number;
  alreadyReminded: number;
  skipped: number;
}

const families = (n: number) => `${n} ${n === 1 ? "family" : "families"}`;
const books = (n: number) => `${n} ${n === 1 ? "book" : "books"}`;

/** One plain sentence per outcome of "Send reminders". */
function bulkMessage(res: BulkResult): Message {
  const parts: string[] = [];
  if (res.reminded > 0) {
    parts.push(`Reminders sent to ${families(res.reminded)} about ${books(res.books)}.`);
  }
  if (res.alreadyReminded > 0) {
    parts.push(
      `${books(res.alreadyReminded)} already had a reminder today, so ${res.alreadyReminded === 1 ? "it was" : "they were"} skipped.`,
    );
  }
  if (res.skipped > 0) {
    parts.push(`${books(res.skipped)} ${res.skipped === 1 ? "is" : "are"} no longer out.`);
  }
  if (res.notYet > 0) {
    parts.push(
      `${families(res.notYet)} still to go: press Send reminders again to email the rest.`,
    );
  }
  if (res.deferred > 0) {
    parts.push(
      `Today's emails are nearly used up, so ${families(res.deferred)} will need a reminder tomorrow.`,
    );
  }
  if (res.noEmail > 0) {
    parts.push(
      `${families(res.noEmail)} ${res.noEmail === 1 ? "has" : "have"} no parent email address, so no reminder went.`,
    );
  }
  if (res.failed > 0) {
    parts.push(
      `${families(res.failed)} couldn't be emailed. Check the email settings, then try again.`,
    );
  }
  const bad = res.reminded === 0 && (res.deferred > 0 || res.failed > 0 || res.noEmail > 0);
  return { kind: bad ? "error" : "success", text: parts.join(" ") || "Nothing to send." };
}

function LoanCard({
  loan,
  message,
  onRun,
  selected,
  selectDisabled,
  onSelect,
}: {
  loan: Loan;
  message: Message | undefined;
  onRun: (loan: Loan, request: () => Promise<unknown>, success: string) => Promise<void>;
  selected: boolean;
  selectDisabled: boolean;
  onSelect: (on: boolean) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"lost" | "damaged" | null>(null);
  const [open, setOpen] = useState(false);
  const messageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) messageRef.current?.focus();
  }, [message]);

  const act = async (key: string, request: () => Promise<unknown>, success: string) => {
    setBusy(key);
    await onRun(loan, request, success);
    setBusy(null);
    setConfirming(null);
  };
  const close = (outcome: "returned" | "lost" | "damaged", success: string) =>
    act(outcome, () => api(`/admin/loans/${loan.id}/close`, { body: { outcome } }), success);

  const late = lateText(loan.overdueDays);
  const locked = busy !== null;
  return (
    <li className={`card${selected ? " card--selected" : ""}`}>
      <label className="loan-select">
        <input
          type="checkbox"
          checked={selected}
          disabled={selectDisabled}
          onChange={(e) => onSelect(e.target.checked)}
        />
        <span className="visually-hidden">
          Select {loan.title}, copy {loan.code} ({loan.familyName})
        </span>
      </label>
      <p>
        <Link href={`/admin/catalog/${loan.titleId}`}>
          <strong>{loan.title}</strong>
        </Link>{" "}
        <span className="muted code">{loan.code}</span>
      </p>
      <p className="loan-family">
        {loan.familyName}
        {loan.kioskName !== null && (
          <span className="muted"> · Kiosk{loan.kioskName ? ` · ${loan.kioskName}` : ""}</span>
        )}
      </p>
      <p className="meta-row">
        <span className={late ? "late" : ""}>
          {late ? `${late} (due ${formatDate(loan.dueOn)})` : `Due ${formatDate(loan.dueOn)}`}
        </span>
        {loan.needsStaff && <span className="badge badge--lost">Follow up</span>}
        {loan.reportedFound && <span className="badge badge--found">Reported found</span>}
        {loan.handedBack && (
          <span className="badge badge--info">
            Handed back
            {loan.handedBackDaysAgo
              ? ` ${loan.handedBackDaysAgo} ${loan.handedBackDaysAgo === 1 ? "day" : "days"} ago`
              : " today"}
          </span>
        )}
      </p>
      <div className="loan-buttons">
        <Button
          variant="secondary"
          onClick={() => close("returned", `“${loan.title}” is checked in.`)}
          busy={busy === "returned"}
          busyLabel="Checking in…"
          disabled={locked && busy !== "returned"}
          aria-label={`${loan.handedBack ? "Check in" : "Mark returned"}: ${loan.title}`}
        >
          {loan.handedBack ? "Check in" : "Mark returned"}
        </Button>
        <Button
          variant="secondary"
          aria-expanded={open}
          aria-controls={`more-${loan.id}`}
          aria-label={`More actions: ${loan.title}`}
          onClick={() => {
            setOpen(!open);
            setConfirming(null);
          }}
        >
          More <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </Button>
      </div>
      <div ref={messageRef} tabIndex={-1} className="loan-message">
        {message && <Alert kind={message.kind}>{message.text}</Alert>}
      </div>
      {open && (
        <div className="loan-more" id={`more-${loan.id}`}>
          {confirming ? (
            <div className="confirm">
              <p className="confirm__text">
                Mark “{loan.title}” as{" "}
                {confirming === "lost" ? "lost (it can't be found)" : "damaged"}? This closes the
                loan.
              </p>
              <div className="row">
                <Button variant="secondary" onClick={() => setConfirming(null)} autoFocus>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  onClick={() => close(confirming, `“${loan.title}” is marked ${confirming}.`)}
                  busy={busy === confirming}
                  busyLabel="Saving…"
                >
                  Yes, mark {confirming}
                </Button>
              </div>
            </div>
          ) : (
            <div className="row">
              {!loan.hasEmail && loan.familyId && (
                <span className="muted">No email: remind them in person.</span>
              )}
              {loan.hasEmail && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    act(
                      "remind",
                      () => api(`/admin/loans/${loan.id}/remind`, { body: {} }),
                      `Reminder sent to the ${loan.familyName} family.`,
                    )
                  }
                  busy={busy === "remind"}
                  busyLabel="Sending…"
                  disabled={locked && busy !== "remind"}
                  aria-label={`Send reminder: ${loan.title}`}
                >
                  Send reminder
                </Button>
              )}
              {loan.canExtend && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    act(
                      "extend",
                      () => api(`/loans/${loan.id}/extend`, { body: {} }),
                      `“${loan.title}” has a new due date.`,
                    )
                  }
                  busy={busy === "extend"}
                  busyLabel="Extending…"
                  disabled={locked && busy !== "extend"}
                  aria-label={`Extend: ${loan.title}`}
                >
                  Extend
                </Button>
              )}
              <Button
                variant="link"
                onClick={() => setConfirming("lost")}
                aria-label={`Mark lost: ${loan.title}`}
              >
                Mark lost (can't be found)
              </Button>
              <Button
                variant="link"
                onClick={() => setConfirming("damaged")}
                aria-label={`Mark damaged: ${loan.title}`}
              >
                Mark damaged
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
