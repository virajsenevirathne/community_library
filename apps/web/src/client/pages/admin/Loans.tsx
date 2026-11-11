import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Layout, Loading } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { formatDate, lateText } from "../../lib/copies.ts";
import { Link, useLocation } from "../../lib/router.tsx";

interface Loan {
  id: string;
  code: string;
  title: string;
  titleId: string;
  familyName: string;
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
  { id: "follow-up", label: "Follow up" },
  { id: "found", label: "Reported found" },
  { id: "check-in", label: "Waiting for check-in" },
] as const;

const EMPTY: Record<string, string> = {
  all: "No books are out right now.",
  overdue: "Nothing is overdue.",
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
  const [error, setError] = useState("");
  // A message shown on the card that was acted on, or at the top if the card left the list.
  const [cardMessage, setCardMessage] = useState<{ loanId: string } & Message>();
  const [topMessage, setTopMessage] = useState<Message>();
  const topRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ loans: Loan[] }>(`/admin/loans?filter=${filter}`);
      setLoans(res.loans);
      setError("");
      return res.loans;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    }
  }, [filter]);
  useEffect(() => {
    setLoans(null);
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

  return (
    <Layout title="Loans" back="/admin">
      <nav aria-label="Filter loans" className="segmented">
        {FILTERS.map((f) => (
          <Link
            key={f.id}
            href={f.id === "all" ? "/admin/loans" : `/admin/loans?filter=${f.id}`}
            aria-current={filter === f.id ? "page" : undefined}
          >
            {f.label}
          </Link>
        ))}
      </nav>
      <Alert>{error}</Alert>
      <div ref={topRef} tabIndex={-1}>
        {topMessage && <Alert kind={topMessage.kind}>{topMessage.text}</Alert>}
      </div>
      {loans === null ? (
        !error && <Loading label="Loading loans…" />
      ) : loans.length === 0 ? (
        <p>{EMPTY[filter]}</p>
      ) : (
        <ul className="loan-list">
          {loans.map((loan) => (
            <LoanCard
              key={loan.id}
              loan={loan}
              message={cardMessage?.loanId === loan.id ? cardMessage : undefined}
              onRun={run}
            />
          ))}
        </ul>
      )}
      <p>
        <Link href="/admin/returns">Checking in a basket of books? Use the scanner</Link>
      </p>
    </Layout>
  );
}

function LoanCard({
  loan,
  message,
  onRun,
}: {
  loan: Loan;
  message: Message | undefined;
  onRun: (loan: Loan, request: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"lost" | "damaged" | null>(null);
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
    <li className="card">
      <p>
        <Link href={`/admin/catalog/${loan.titleId}`}>
          <strong>{loan.title}</strong>
        </Link>{" "}
        <span className="muted code">{loan.code}</span>
      </p>
      <p className="meta-row">
        <span>{loan.familyName}</span>
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
      <div ref={messageRef} tabIndex={-1}>
        {message && <Alert kind={message.kind}>{message.text}</Alert>}
      </div>
      <div className="row">
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
      </div>
      <details className="more">
        <summary>More</summary>
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
      </details>
    </li>
  );
}
