import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Scanner, signal } from "../components/Scanner.tsx";
import { Alert, Button, Loading } from "../components.tsx";
import { JoeyMark } from "../icons.tsx";
import { ApiError, api, errorMessage } from "../lib/api.ts";
import { authClient } from "../lib/auth.ts";
import { formatDate, parseCopyCode } from "../lib/copies.ts";
import { libraryBase, navigate } from "../lib/router.tsx";
import { useSession } from "../lib/session.tsx";
import { Cover } from "./admin/Cover.tsx";

/*
 * The kiosk: a shared tablet by the shelf. Scan or type a book's code, then
 * borrow it with a personal 6-digit code, or return it without one. Each
 * borrow or return ends on a confirmation that clears itself, so the next
 * family starts fresh.
 */

interface KioskInfo {
  kiosk: { name: string };
  library: { name: string; slug: string; paused: boolean; returnsNeedCheckIn: boolean };
}

interface KioskCopy {
  code: string;
  title: { title: string; authors: string; coverUrl: string | null };
  state: "available" | "out" | "handedBack" | "unavailable";
}

type Screen =
  | { kind: "start" }
  | { kind: "book"; copy: KioskCopy }
  | { kind: "code"; copy: KioskCopy }
  | {
      kind: "done";
      title: string;
      lines: ReactNode[];
      tone: "success" | "info" | "error";
      copy?: KioskCopy;
    };

const CODE_LENGTH = 6;
/** Seconds a confirmation stays up before the kiosk starts again. */
const DONE_SECONDS = 8;
const PROBLEM_SECONDS = 15;
/** A half-finished borrow is abandoned after this long without a tap. */
const IDLE_SECONDS = 60;
const CAMERA_KEY = "kioskCamera";

function readCameraChoice(): boolean {
  try {
    return localStorage.getItem(CAMERA_KEY) !== "off";
  } catch {
    return true;
  }
}

function saveCameraChoice(on: boolean) {
  try {
    localStorage.setItem(CAMERA_KEY, on ? "on" : "off");
  } catch {
    // Private mode: the camera just starts on again next time.
  }
}

export function KioskPage() {
  const [info, setInfo] = useState<KioskInfo | null>(null);
  const [problem, setProblem] = useState<{ code: string; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const found = await api<KioskInfo>("/kiosk");
      // A kiosk belongs to one library: its page is at that library's address.
      if (libraryBase() !== found.library.slug) {
        navigate(`/${found.library.slug}/kiosk`, { replace: true, absolute: true });
      }
      setInfo(found);
      setProblem(null);
    } catch (e) {
      setInfo(null);
      setProblem({ code: e instanceof ApiError ? e.code : "error", message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The kiosk fills the screen: no tab bar space.
  useEffect(() => {
    document.body.classList.add("kiosk-mode");
    return () => document.body.classList.remove("kiosk-mode");
  }, []);

  useEffect(() => {
    document.title = info ? `Kiosk · ${info.library.name}` : "Kiosk";
  }, [info]);

  if (!info) {
    if (!problem) {
      return (
        <main className="kiosk">
          <h1 className="visually-hidden">Kiosk</h1>
          <Loading label="Starting the kiosk…" />
        </main>
      );
    }
    const notKiosk = problem.code === "not_a_kiosk" || problem.code === "kiosk_off";
    return (
      <main className="kiosk">
        <div className="kiosk__panel stack">
          <h1>{notKiosk ? "This tablet isn't a kiosk" : "The kiosk can't start"}</h1>
          <p className="lead">{problem.message}</p>
          {notKiosk ? (
            <p>
              A library admin can turn it on: sign in on this tablet, open <strong>Settings</strong>
              , and choose <strong>Use this tablet as a kiosk</strong>.
            </p>
          ) : (
            <Button onClick={() => void load()}>Try again</Button>
          )}
          <StaffCorner />
        </div>
      </main>
    );
  }
  return <Kiosk info={info} onLost={load} />;
}

function Kiosk({ info, onLost }: { info: KioskInfo; onLost: () => Promise<void> }) {
  const [screen, setScreen] = useState<Screen>({ kind: "start" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const onLostRef = useRef(onLost);
  onLostRef.current = onLost;

  const restart = useCallback(() => {
    setScreen({ kind: "start" });
    setError("");
    setBusy(false);
    // Between families, check the kiosk is still on and the library's state.
    void onLostRef.current();
  }, []);

  // Each new screen is announced by moving focus to its heading.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the screen is the trigger
  useEffect(() => {
    heading.current?.focus();
  }, [screen]);

  // A borrow left half-way (someone walked off) clears itself.
  useEffect(() => {
    if (screen.kind !== "book" && screen.kind !== "code") return;
    let timer = setTimeout(restart, IDLE_SECONDS * 1000);
    const nudge = () => {
      clearTimeout(timer);
      timer = setTimeout(restart, IDLE_SECONDS * 1000);
    };
    window.addEventListener("pointerdown", nudge);
    window.addEventListener("keydown", nudge);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", nudge);
      window.removeEventListener("keydown", nudge);
    };
  }, [screen, restart]);

  /** Shared handling for answers that end the kiosk session or show a problem. */
  const handleError = (e: unknown, copy?: KioskCopy) => {
    if (e instanceof ApiError && (e.code === "kiosk_off" || e.code === "not_a_kiosk")) {
      void onLost();
      return;
    }
    signal("error");
    setScreen({
      kind: "done",
      title: "That didn't work",
      lines: [errorMessage(e)],
      tone: "error",
      ...(copy ? { copy } : {}),
    });
  };

  const findBook = async (raw: string) => {
    const code = parseCopyCode(raw);
    if (!code) {
      signal("error");
      setError("That isn't a book code. Book codes are 4 to 6 letters and numbers, like K7R2.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await api<{ copy: KioskCopy }>(`/kiosk/copies/${encodeURIComponent(code)}`);
      signal("ok");
      setScreen({ kind: "book", copy: res.copy });
    } catch (e) {
      if (e instanceof ApiError && e.code === "copy_not_found") {
        signal("error");
        setError(e.message);
      } else handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const returnBook = async (copy: KioskCopy) => {
    setBusy(true);
    try {
      const res = await api<{
        returned?: boolean;
        pendingCheckIn?: boolean;
        alreadyReturned?: boolean;
      }>(`/kiosk/copies/${encodeURIComponent(copy.code)}/return`, { body: {} });
      signal("ok");
      setScreen(
        res.pendingCheckIn
          ? {
              kind: "done",
              title: "Thank you!",
              lines: ["Please put the book in the returns basket."],
              tone: "success",
              copy,
            }
          : res.alreadyReturned
            ? {
                kind: "done",
                title: "It's already back",
                lines: ["This book is already returned. Please put it back on the shelf."],
                tone: "info",
                copy,
              }
            : {
                kind: "done",
                title: "Thanks for bringing it back!",
                lines: ["Please put it back on the shelf."],
                tone: "success",
                copy,
              },
      );
    } catch (e) {
      handleError(e, copy);
    } finally {
      setBusy(false);
    }
  };

  const paused = info.library.paused;

  return (
    <main className="kiosk">
      <header className="kiosk__top">
        <span className="kiosk__brand">
          <JoeyMark className="brand__mark" />
          <span>{info.library.name}</span>
        </span>
        {screen.kind !== "start" && (
          <Button variant="secondary" onClick={restart}>
            Start again
          </Button>
        )}
      </header>

      <div className="kiosk__panel">
        {paused && (
          <Alert kind="warning">
            The library is paused, so books can't be borrowed or returned here right now. Please ask
            the staff.
          </Alert>
        )}

        {screen.kind === "start" && (
          <StartScreen heading={heading} busy={busy} error={error} onCode={findBook} />
        )}

        {screen.kind === "book" && (
          <BookScreen
            heading={heading}
            copy={screen.copy}
            busy={busy}
            paused={paused}
            onBorrow={() => {
              setError("");
              setScreen({ kind: "code", copy: screen.copy });
            }}
            onReturn={() => void returnBook(screen.copy)}
          />
        )}

        {screen.kind === "code" && (
          <CodeScreen
            heading={heading}
            copy={screen.copy}
            onBorrowed={(b) => {
              signal("ok");
              setScreen({
                kind: "done",
                title: "Enjoy the book!",
                lines: [
                  b.name ? (
                    <>
                      Borrowed by <strong>{b.name}</strong> · {b.family} family
                    </>
                  ) : (
                    <>
                      Borrowed for the <strong>{b.family}</strong> family
                    </>
                  ),
                  b.dueOn ? (
                    <>
                      Due back <strong>{formatDate(b.dueOn)}</strong>
                    </>
                  ) : null,
                ],
                tone: "success",
                copy: screen.copy,
              });
            }}
            onProblem={(e) => handleError(e, screen.copy)}
          />
        )}

        {screen.kind === "done" && (
          <DoneScreen
            heading={heading}
            screen={screen}
            seconds={screen.tone === "error" ? PROBLEM_SECONDS : DONE_SECONDS}
            onDone={restart}
            {...(screen.tone === "error" && screen.copy
              ? { onRetry: () => setScreen({ kind: "book", copy: screen.copy as KioskCopy }) }
              : {})}
          />
        )}
      </div>
      <StaffCorner />
    </main>
  );
}

type HeadingRef = RefObject<HTMLHeadingElement | null>;

/**
 * Waiting for a book: the camera reads the sticker, a USB scanner types the
 * code (it's caught without a text box having focus), or it can be typed.
 */
function StartScreen({
  heading,
  busy,
  error,
  onCode,
}: {
  heading: HeadingRef;
  busy: boolean;
  error: string;
  onCode: (code: string) => void;
}) {
  const [camera, setCamera] = useState(readCameraChoice);
  const [typed, setTyped] = useState("");
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // The camera reads a sticker again and again: once is enough for a while.
  const lastScan = useRef({ code: "", at: 0 });
  const onScan = (code: string) => {
    const now = Date.now();
    if (code === lastScan.current.code && now - lastScan.current.at < 5000) return;
    lastScan.current = { code, at: now };
    onCode(code);
  };

  // A USB or Bluetooth scanner types the code quickly and presses Enter.
  useEffect(() => {
    let buffer = "";
    let last = 0;
    const onKey = (event: KeyboardEvent) => {
      // Typing in the code box is the box's job. A focused button (after a
      // tap) doesn't stop the scanner, but its Enter mustn't click it too.
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) return;
      const now = Date.now();
      if (now - last > 300) buffer = "";
      last = now;
      if (event.key === "Enter") {
        if (buffer.length >= 4) {
          event.preventDefault();
          if (!busyRef.current) onCodeRef.current(buffer);
        }
        buffer = "";
      } else if (event.key.length === 1) buffer += event.key;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onCode(typed);
  };

  return (
    <div className="stack">
      <h1 ref={heading} tabIndex={-1} className="kiosk__title">
        Borrow or return a book
      </h1>
      <p className="lead">Scan the sticker inside the book's cover.</p>
      {error && <Alert>{error}</Alert>}
      {camera ? (
        <>
          <Scanner
            label="Camera view for scanning a book's sticker"
            hint="Hold the sticker inside the cover up to the camera"
            typeWhat="code"
            formats={["qr_code"]}
            accept={parseCopyCode}
            onScan={onScan}
            paused={busy}
            sound={false}
          />
          <Button
            variant="secondary"
            onClick={(event) => {
              event.currentTarget.blur();
              setCamera(false);
              saveCameraChoice(false);
            }}
          >
            Turn the camera off
          </Button>
        </>
      ) : (
        <Button
          variant="secondary"
          onClick={(event) => {
            event.currentTarget.blur();
            setCamera(true);
            saveCameraChoice(true);
          }}
        >
          Use the camera
        </Button>
      )}
      <form className="kiosk__type" onSubmit={submit}>
        <label htmlFor="kiosk-book-code">Or type the code under the sticker</label>
        <div className="row">
          <input
            id="kiosk-book-code"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={40}
            placeholder="K7R2"
          />
          <Button type="submit" busy={busy} busyLabel="Finding…">
            Find the book
          </Button>
        </div>
      </form>
    </div>
  );
}

function BookCard({ copy, small = false }: { copy: KioskCopy; small?: boolean }) {
  return (
    <div className="kiosk__book">
      <Cover url={copy.title.coverUrl} title={copy.title.title} size={small ? "sm" : "lg"} />
      <div>
        <p className="kiosk__book-title">{copy.title.title}</p>
        {copy.title.authors && <p className="muted">{copy.title.authors}</p>}
      </div>
    </div>
  );
}

function BookScreen({
  heading,
  copy,
  busy,
  paused,
  onBorrow,
  onReturn,
}: {
  heading: HeadingRef;
  copy: KioskCopy;
  busy: boolean;
  paused: boolean;
  onBorrow: () => void;
  onReturn: () => void;
}) {
  const titles: Record<KioskCopy["state"], string> = {
    available: "Borrow this book?",
    out: "Bringing it back?",
    handedBack: "Already handed back",
    unavailable: "This book can't be borrowed",
  };
  return (
    <div className="stack">
      <h1 ref={heading} tabIndex={-1} className="kiosk__title">
        {titles[copy.state]}
      </h1>
      <BookCard copy={copy} />
      {copy.state === "available" && (
        <Button className="btn--big btn--block" onClick={onBorrow} disabled={paused}>
          Borrow this book
        </Button>
      )}
      {copy.state === "out" && (
        <Button
          className="btn--big btn--block btn--return"
          onClick={onReturn}
          busy={busy}
          busyLabel="Returning…"
          disabled={paused}
        >
          Return this book
        </Button>
      )}
      {copy.state === "handedBack" && (
        <Alert kind="info" live={false}>
          This book is waiting for staff to check it in. Please put it in the returns basket.
        </Alert>
      )}
      {copy.state === "unavailable" && (
        <Alert kind="info" live={false}>
          Please give this book to the staff.
        </Alert>
      )}
    </div>
  );
}

/** The personal code: a big keypad, with the digits hidden as they're typed. */
function CodeScreen({
  heading,
  copy,
  onBorrowed,
  onProblem,
}: {
  heading: HeadingRef;
  copy: KioskCopy;
  onBorrowed: (b: { name: string; family: string; dueOn: string | null }) => void;
  onProblem: (e: unknown) => void;
}) {
  const [digits, setDigits] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const wait = waitUntil ? Math.max(0, Math.ceil((waitUntil - now) / 1000)) : 0;
  const locked = wait > 0;
  const firstKey = useRef<HTMLButtonElement>(null);
  // A reply that arrives after the kiosk moved on (the idle reset) is dropped,
  // so the next family never sees the last one's name.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // After a wrong code, keyboard and switch users carry on from the keypad.
  useEffect(() => {
    if (error && !busy) {
      if (locked) heading.current?.focus();
      else firstKey.current?.focus();
    }
  }, [error, busy, locked, heading]);

  useEffect(() => {
    if (!waitUntil) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [waitUntil]);

  useEffect(() => {
    if (waitUntil && !locked) {
      setWaitUntil(null);
      setError("");
    }
  }, [waitUntil, locked]);

  const submit = useCallback(
    async (code: string) => {
      setBusy(true);
      setError("");
      try {
        const res = await api<{
          borrowed: { name: string; family: string; dueOn: string | null };
        }>(`/kiosk/copies/${encodeURIComponent(copy.code)}/borrow`, { body: { code } });
        if (mounted.current) onBorrowed(res.borrowed);
      } catch (e) {
        if (!mounted.current) return;
        setDigits("");
        if (e instanceof ApiError && e.code === "wrong_code") {
          signal("error");
          setError(e.message);
        } else if (e instanceof ApiError && e.code === "kiosk_locked") {
          signal("error");
          const seconds = Number(e.details?.retryAfter) || 60;
          setNow(Date.now());
          setWaitUntil(Date.now() + seconds * 1000);
          setError(e.message);
        } else {
          onProblem(e);
        }
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [copy.code, onBorrowed, onProblem],
  );

  const press = useCallback(
    (key: string) => {
      if (busy || locked) return;
      if (key === "delete") setDigits(digits.slice(0, -1));
      else if (key === "clear") setDigits("");
      else if (digits.length < CODE_LENGTH) {
        const next = digits + key;
        setDigits(next);
        if (next.length === CODE_LENGTH) void submit(next);
      }
    },
    [busy, locked, digits, submit],
  );

  // A keyboard works too. A barcode scanner types a whole burst of keys in a
  // few milliseconds: a burst is a book being scanned, not a code, so it's dropped.
  const pressRef = useRef(press);
  pressRef.current = press;
  useEffect(() => {
    let pending: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (event: KeyboardEvent) => {
      const key = /^\d$/.test(event.key) ? event.key : event.key === "Backspace" ? "delete" : null;
      if (key === null && event.key !== "Enter" && event.key.length !== 1) return;
      pending.push(key ?? "");
      clearTimeout(timer);
      timer = setTimeout(() => {
        const keys = pending;
        pending = [];
        if (keys.length === 1 && keys[0]) pressRef.current(keys[0]);
      }, 60);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="kiosk__code">
      <div className="stack">
        <h1 ref={heading} tabIndex={-1} className="kiosk__title">
          Type your kiosk code
        </h1>
        <BookCard copy={copy} small />
        <p className="muted">
          Your own 6-digit code. Don't have one? Get it on your Account page, or ask the staff.
        </p>
      </div>
      <div className="stack">
        <output className="kiosk__dots">
          <span className="visually-hidden">
            {digits.length} of {CODE_LENGTH} digits typed
          </span>
          {Array.from({ length: CODE_LENGTH }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed positions
              key={i}
              aria-hidden="true"
              className={`kiosk__dot${i < digits.length ? " kiosk__dot--on" : ""}`}
            />
          ))}
        </output>
        {busy && <Loading label="Checking your code…" />}
        {error && <Alert>{error}</Alert>}
        {locked && (
          <p className="muted" aria-hidden="true">
            You can try again in {wait} seconds.
          </p>
        )}
        <div className="kiosk__keypad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
            <button
              key={d}
              ref={d === "1" ? firstKey : undefined}
              type="button"
              className="kiosk__key"
              onClick={() => press(d)}
              disabled={busy || locked}
            >
              {d}
            </button>
          ))}
          <button
            type="button"
            className="kiosk__key kiosk__key--small"
            onClick={() => press("clear")}
            disabled={busy || locked || digits.length === 0}
            aria-label="Clear all digits"
          >
            Clear
          </button>
          <button
            type="button"
            className="kiosk__key"
            onClick={() => press("0")}
            disabled={busy || locked}
          >
            0
          </button>
          <button
            type="button"
            className="kiosk__key kiosk__key--small"
            onClick={() => press("delete")}
            disabled={busy || locked || digits.length === 0}
            aria-label="Delete the last digit"
          >
            ⌫
          </button>
        </div>
      </div>
    </div>
  );
}

function DoneScreen({
  heading,
  screen,
  seconds,
  onDone,
  onRetry,
}: {
  heading: HeadingRef;
  screen: Extract<Screen, { kind: "done" }>;
  seconds: number;
  onDone: () => void;
  /** For a problem: back to the book, to try again. */
  onRetry?: () => void;
}) {
  const [left, setLeft] = useState(seconds);
  const [kept, setKept] = useState(false);
  useEffect(() => {
    if (kept) return;
    const timer = setInterval(() => setLeft((s) => s - 1), 1000);
    return () => clearInterval(timer);
  }, [kept]);
  useEffect(() => {
    if (left <= 0 && !kept) onDone();
  }, [left, kept, onDone]);

  return (
    <div className="stack kiosk__done">
      <h1 ref={heading} tabIndex={-1} className="kiosk__title">
        {screen.title}
      </h1>
      {screen.copy && <BookCard copy={screen.copy} />}
      <Alert kind={screen.tone}>
        {screen.lines.filter(Boolean).map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines never reorder
          <p key={i}>{line}</p>
        ))}
      </Alert>
      {onRetry && (
        <Button className="btn--big btn--block" onClick={onRetry}>
          Try again
        </Button>
      )}
      <Button
        className="btn--big btn--block"
        variant={onRetry ? "secondary" : "primary"}
        onClick={onDone}
      >
        Done
      </Button>
      {kept ? null : (
        <p className="muted">
          <span aria-hidden="true">Starting again in {Math.max(0, left)} seconds. </span>
          <Button variant="link" onClick={() => setKept(true)}>
            Keep this on screen
          </Button>
        </p>
      )}
    </div>
  );
}

/**
 * A small way out for staff. When someone is still signed in on the tablet,
 * it says so: a kiosk shouldn't keep a person's sign-in.
 */
function StaffCorner() {
  const { state, refresh } = useSession();
  const user = state.status === "ready" ? state.me.user : null;
  const slug = libraryBase();
  const settings = slug ? `/${slug}/admin/settings` : "/";
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  return (
    <footer className="kiosk__staff">
      {user ? (
        <>
          <span>
            {problem ||
              "Someone from the staff is still signed in on this tablet. Sign out before leaving it as a kiosk."}
          </span>
          <Button
            variant="secondary"
            busy={busy}
            busyLabel="Signing out…"
            onClick={async () => {
              setBusy(true);
              setProblem("");
              try {
                await authClient.signOut();
                await refresh();
              } catch {
                setProblem("Couldn't sign out. Check the connection and try again.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Sign out
          </Button>
          <a className="kiosk__staff-link" href={settings}>
            Settings
          </a>
        </>
      ) : (
        <a className="kiosk__staff-link" href={`/signin?next=${encodeURIComponent(settings)}`}>
          Staff
        </a>
      )}
    </footer>
  );
}
