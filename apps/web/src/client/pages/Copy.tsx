import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Alert, Button, Field, Layout, Loading } from "../components.tsx";
import { ApiError, api, errorMessage } from "../lib/api.ts";
import { type CopyView, formatDate, lateText, parseCopyCode } from "../lib/copies.ts";
import { Link, libraryBase, navigate } from "../lib/router.tsx";
import { isStaff, useSession } from "../lib/session.tsx";
import { Cover } from "./admin/Cover.tsx";

type Action = "borrow" | "return" | "found";

type Done =
  | { kind: "borrowed"; dueOn: string; movedForClosure: boolean }
  | { kind: "returned"; checkedInForOthers: boolean; pendingCheckIn: boolean }
  | { kind: "found" }
  | { kind: "extended"; dueOn: string };

const DONE_TITLES: Record<Done["kind"], string> = {
  borrowed: "Enjoy the book!",
  returned: "Thanks for bringing it back",
  found: "Thanks for finding it",
  extended: "Due date extended",
};

interface PageError {
  message: string;
  code: string;
}

function toPageError(e: unknown): PageError {
  return { message: errorMessage(e), code: e instanceof ApiError ? e.code : "error" };
}

/**
 * A book's page, opened by scanning the QR sticker inside its cover. It works
 * out who holds the copy and offers the one action that makes sense.
 */
export function CopyPage({ code }: { code: string }) {
  const { state } = useSession();
  const me = state.status === "ready" ? state.me : null;
  const [copy, setCopy] = useState<CopyView | null>(null);
  const [error, setError] = useState<PageError | null>(null);
  const [busy, setBusy] = useState<Action | "extend" | "load" | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  /** Reloads the copy. A failed action's message is kept, so the reason stays on screen. */
  const load = useCallback(
    async (keepError = false) => {
      try {
        const found = (await api<{ copy: CopyView }>(`/copies/${encodeURIComponent(code)}`)).copy;
        // A sticker's short address (/c/K7R2), or a book opened from another
        // library's pages, moves to the book's own library, so the page shows
        // that library and what this person can do there.
        const here = libraryBase();
        if (here !== found.library.slug) {
          // Say so when the scan came from another library's pages.
          const from = here ? `?from=${encodeURIComponent(here)}` : "";
          navigate(`/${found.library.slug}/c/${found.code}${from}`, {
            replace: true,
            absolute: true,
          });
          return;
        }
        setCopy(found);
        if (!keepError) setError(null);
      } catch (e) {
        setError(toPageError(e));
      }
    },
    [code],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: Action) => {
    const before = copy;
    setBusy(action);
    setError(null);
    try {
      const res = await api<{
        copy: CopyView;
        dueOn?: string;
        movedForClosure?: boolean;
        pendingCheckIn?: boolean;
      }>(`/copies/${encodeURIComponent(code)}/${action}`, { body: {} });
      setCopy(res.copy);
      if (action === "borrow") {
        setDone({
          kind: "borrowed",
          dueOn: res.dueOn ?? res.copy.loan?.dueOn ?? "",
          movedForClosure: res.movedForClosure ?? false,
        });
      } else if (action === "return") {
        // Staff checking in another family's book see "checked in"; everyone else "returned".
        setDone({
          kind: "returned",
          checkedInForOthers: before?.state === "out",
          pendingCheckIn: res.pendingCheckIn === true,
        });
      } else setDone({ kind: "found" });
    } catch (e) {
      setError(toPageError(e));
      setDone(null);
      await load(true);
    } finally {
      setBusy(null);
    }
  };

  const extend = async () => {
    if (!copy?.loan) return;
    setBusy("extend");
    setError(null);
    try {
      const res = await api<{ dueOn: string }>(`/loans/${copy.loan.id}/extend`, { body: {} });
      setDone({ kind: "extended", dueOn: res.dueOn });
      await load();
    } catch (e) {
      setError(toPageError(e));
    } finally {
      setBusy(null);
    }
  };

  if (!copy) {
    if (!error) {
      return (
        <Layout title="Finding the book…">
          <Loading />
        </Layout>
      );
    }
    if (error.code === "copy_not_found") {
      return (
        <Layout title="Book not found">
          <Alert>{error.message}</Alert>
          <CodeForm initial={code} />
        </Layout>
      );
    }
    return (
      <Layout title="Couldn't open the book">
        <Alert>{error.message}</Alert>
        <Button
          variant="secondary"
          busy={busy === "load"}
          busyLabel="Trying again…"
          onClick={async () => {
            setBusy("load");
            await load();
            setBusy(null);
          }}
        >
          Try again
        </Button>
      </Layout>
    );
  }

  const fromSlug = new URLSearchParams(window.location.search).get("from");
  const movedFrom = fromSlug !== null && fromSlug !== copy.library.slug;
  const staff = me ? isStaff(me) : false;
  const family = copy.family;

  return (
    <Layout
      title={done ? DONE_TITLES[done.kind] : copy.title.title}
      focusKey={done?.kind ?? "copy"}
    >
      <div className="book-layout">
        <div className="book-hero">
          <Cover url={copy.title.coverUrl} title={copy.title.title} size="lg" />
        </div>
        <div>
          <div className="book-hero__text">
            {movedFrom && (
              <Alert kind="info">
                This book belongs to <strong>{copy.library.name}</strong>, so you're now in that
                library.
              </Alert>
            )}
            {done && (
              <p>
                <strong>{copy.title.title}</strong>
              </p>
            )}
            {copy.title.authors && <p>{copy.title.authors}</p>}
            <p className="row row--tight">
              {!done && <StatusPill copy={copy} />}
              <span className="muted">
                Book code <span className="code">{copy.code}</span>
              </span>
            </p>
          </div>
          {error && <Alert>{error.message}</Alert>}

          {done?.kind === "borrowed" && (
            <div className="stack">
              <Alert kind="success">
                Due back <strong>{formatDate(done.dueOn)}</strong>
                {done.movedForClosure && " (moved to a day the library is open)"}.
                {family && ` That's ${family.booksOut} of ${family.maxLoans} books out.`} A
                confirmation email is on its way.
              </Alert>
              <p className="lead">Borrowing another? Scan the next sticker with your camera.</p>
              <div className="row">
                <Link href="/" className="btn btn--secondary">
                  See your books
                </Link>
                <Button
                  variant="link"
                  onClick={() => act("return")}
                  busy={busy === "return"}
                  busyLabel="Undoing…"
                >
                  Tapped by mistake? Undo
                </Button>
              </div>
            </div>
          )}
          {done?.kind === "returned" && (
            <div className="stack">
              <Alert kind="success">
                {done.pendingCheckIn
                  ? "Handed back. Please put it in the returns basket. It stays on your list until staff check it in."
                  : `${done.checkedInForOthers ? "Checked in." : "Returned."} Please put the book back on the shelf.`}
              </Alert>
              <p className="lead">Returning another? Scan the next sticker.</p>
              {!done.checkedInForOthers && (
                <Button
                  variant="link"
                  onClick={() => act("borrow")}
                  busy={busy === "borrow"}
                  busyLabel="Undoing…"
                >
                  Tapped by mistake? Undo
                </Button>
              )}
            </div>
          )}
          {done?.kind === "found" && (
            <Alert kind="success">
              We've let its family know. Please put the book in the returns basket so staff can
              check it in.
            </Alert>
          )}
          {done?.kind === "extended" && (
            <div className="stack">
              <Alert kind="success">
                Now due back <strong>{formatDate(done.dueOn)}</strong>.
              </Alert>
              <Link href="/" className="btn btn--secondary">
                See your books
              </Link>
            </div>
          )}

          {!done && (
            <CopyActions copy={copy} staff={staff} busy={busy} onAct={act} onExtend={extend} />
          )}
        </div>
      </div>
    </Layout>
  );
}

/** One glanceable word or two on where the book is, before any longer text. */
function StatusPill({ copy }: { copy: CopyView }) {
  const [text, tone] =
    copy.state === "available" && copy.can.borrow
      ? ["Ready to borrow", "ok"]
      : copy.state === "available"
        ? ["On the shelf", "ok"]
        : copy.state === "mine"
          ? copy.loan?.handedBack
            ? ["Handed back", ""]
            : (copy.loan?.overdueDays ?? 0) > 0
              ? ["Late", "warn"]
              : ["With your family", ""]
          : copy.state === "out"
            ? ["Borrowed", ""]
            : ["Not for borrowing", "warn"];
  return <span className={`status-pill${tone ? ` status-pill--${tone}` : ""}`}>{text}</span>;
}

function CopyActions(props: {
  copy: CopyView;
  staff: boolean;
  busy: string | null;
  onAct: (action: Action) => void;
  onExtend: () => void;
}) {
  const { copy, staff, busy, onAct, onExtend } = props;
  const family = copy.family;
  // While one action runs, the others wait.
  const locked = busy !== null;

  if (copy.state === "available") {
    if (copy.can.borrow) {
      return (
        <div className="stack">
          {family && (
            <p className="muted">
              Your family has {family.booksOut} of {family.maxLoans} books out.
            </p>
          )}
          <div className="action-dock">
            <Button
              className="btn--block btn--big"
              onClick={() => onAct("borrow")}
              busy={busy === "borrow"}
              busyLabel="Borrowing…"
              disabled={locked && busy !== "borrow"}
            >
              Borrow this book
            </Button>
          </div>
        </div>
      );
    }
    return (
      <Alert kind="info">
        {!family
          ? staff
            ? "You're signed in as staff without a family, so you can't borrow. Ask an admin to add you to one."
            : "Your sign-in isn't connected to a family yet, so you can't borrow. Ask staff to add you to your family."
          : family.status === "pending"
            ? "Your family is waiting for staff approval. You can borrow once they approve it."
            : family.status === "deactivated"
              ? "Your family's library membership is paused, so you can't borrow right now. Please ask the library staff."
              : `Your family already has ${family.maxLoans} books out, the most allowed. Return one to borrow this.`}
      </Alert>
    );
  }

  if (copy.state === "mine" && copy.loan?.handedBack) {
    return (
      <div className="stack">
        <Alert kind="info">
          <strong>Handed back.</strong> Please put it in the returns basket if you haven't yet. It
          stays on your list until staff check it in.
        </Alert>
        <Button
          variant="secondary"
          onClick={() => onAct("borrow")}
          busy={busy === "borrow"}
          busyLabel="Undoing…"
        >
          I still have it: keep it on my list
        </Button>
      </div>
    );
  }

  if (copy.state === "mine" && copy.loan) {
    const late = lateText(copy.loan.overdueDays);
    const left = copy.loan.extensionsLeft ?? 0;
    return (
      <div className="stack">
        <p className="lead">
          Your family has this book. Due back <strong>{formatDate(copy.loan.dueOn)}</strong>
          {late && <span className="badge badge--lost"> {late}</span>}.
        </p>
        {!copy.loan.canExtend && (copy.loan.extensionsLeft ?? 0) === 0 && (
          <p className="muted">
            You've already kept this book longer, so please bring it back by then.
          </p>
        )}
        <div className="action-dock">
          <Button
            className="btn--block btn--big btn--return"
            onClick={() => onAct("return")}
            busy={busy === "return"}
            busyLabel="Returning…"
            disabled={locked && busy !== "return"}
          >
            Return this book
          </Button>
          {copy.loan.canExtend && (
            <Button
              variant="secondary"
              className="btn--block"
              onClick={onExtend}
              busy={busy === "extend"}
              busyLabel="Extending…"
              disabled={locked && busy !== "extend"}
            >
              Keep it longer
            </Button>
          )}
        </div>
        {copy.loan.canExtend && (
          <p className="muted">
            {left === 1
              ? "1 extension left for this book."
              : `${left} extensions left for this book.`}
          </p>
        )}
      </div>
    );
  }

  if (copy.state === "out") {
    if (staff && copy.loan) {
      const late = lateText(copy.loan.overdueDays);
      return (
        <div className="stack">
          {copy.loan.handedBack && (
            <Alert kind="info">The {copy.loan.familyName} family handed this book back.</Alert>
          )}
          <p className="lead">
            Out with <strong>{copy.loan.familyName}</strong>, due {formatDate(copy.loan.dueOn)}
            {late && <span className="badge badge--lost"> {late}</span>}.
          </p>
          {copy.reportedFound && (
            <Alert kind="info">
              A parent reported finding this book. Check it in now that it's back.
            </Alert>
          )}
          <div className="action-dock">
            <Button
              className="btn--block btn--big"
              onClick={() => onAct("return")}
              busy={busy === "return"}
              busyLabel="Checking in…"
            >
              Check it in
            </Button>
          </div>
        </div>
      );
    }
    if (copy.reportedFound) {
      return (
        <Alert kind="info">
          Someone has already reported finding this book. Please put it in the returns basket.
        </Alert>
      );
    }
    return (
      <div className="stack">
        <p className="lead">This book shows as borrowed by another family.</p>
        <p>
          If you're holding it at the library, tap below. We'll let its family know, and staff will
          check it in from the returns basket.
        </p>
        <Button
          variant="secondary"
          className="btn--block"
          onClick={() => onAct("found")}
          busy={busy === "found"}
          busyLabel="Sending…"
        >
          I found it
        </Button>
      </div>
    );
  }

  const messages: Record<CopyView["status"], string> = {
    lost: "Thanks! This copy was marked lost, so it's great you found it. Please hand it to the library staff.",
    damaged:
      "This copy is marked damaged, so it can't be borrowed. Please hand it to the library staff.",
    retired: "This copy has been retired from the library. Please hand it to the library staff.",
    available: "This copy can't be borrowed right now. Please hand it to the library staff.",
  };
  return (
    <div className="stack">
      <Alert kind="info">{messages[copy.status]}</Alert>
      <Link href="/">Back to your books</Link>
    </div>
  );
}

function CodeForm({ initial = "" }: { initial?: string }) {
  const [code, setCode] = useState(initial.toUpperCase());
  const [error, setError] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseCopyCode(code);
    if (!parsed) {
      setError("That code doesn't look right. It's 4 letters or numbers, like K7R2.");
      return;
    }
    navigate(`/c/${parsed}`);
  };
  return (
    <form onSubmit={submit} noValidate>
      <Field
        label="Book code"
        hint="Printed under the QR sticker inside the book's cover."
        className="code-input"
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        maxLength={200}
        error={error}
        value={code}
        onChange={(e) => {
          setCode(e.target.value.toUpperCase());
          if (error) setError("");
        }}
      />
      <Button type="submit" className="btn--block">
        Find the book
      </Button>
    </form>
  );
}

/** For when a camera won't scan: type the code printed under the QR sticker. */
export function CodeEntryPage() {
  return (
    <Layout title="Type a book code">
      <CodeForm />
    </Layout>
  );
}
