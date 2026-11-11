import { normalizeIsbn } from "@community-library/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Scanner } from "../../components/Scanner.tsx";
import { Alert, Button, Field, Layout, Loading } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { Link, navigate } from "../../lib/router.tsx";
import { Cover } from "./Cover.tsx";

interface Lookup {
  isbn: string;
  found: boolean;
  title?: string;
  authors?: string;
  coverUrl?: string | null;
  existing?: {
    id: string;
    title: string;
    authors: string;
    coverUrl: string | null;
    copies: number;
  };
}

interface SavedTitle {
  id: string;
  title: string;
  copies: { id: string; shortCode: string }[];
}

type Step =
  | { name: "start" }
  | { name: "looking"; isbn: string }
  | {
      name: "details";
      isbn: string | null;
      prefill: { title: string; authors: string; coverUrl: string | null };
      found: boolean;
    }
  | { name: "existing"; isbn: string; existing: NonNullable<Lookup["existing"]> }
  | { name: "saved"; title: SavedTitle; newCopyIds: string[]; added: boolean };

export function AddBooksPage() {
  const [step, setStep] = useState<Step>({ name: "start" });
  const [error, setError] = useState("");
  // Stays on between books, so many books can be scanned one after another.
  const [camera, setCamera] = useState(false);
  const stepName = useRef(step.name);
  stepName.current = step.name;

  const lookUp = async (isbn: string) => {
    // A second scan while a lookup is running is ignored.
    if (stepName.current !== "start") return;
    stepName.current = "looking";
    setError("");
    setStep({ name: "looking", isbn });
    try {
      const result = await api<Lookup>(`/catalog/lookup/${isbn}`);
      if (result.existing)
        setStep({ name: "existing", isbn: result.isbn, existing: result.existing });
      else
        setStep({
          name: "details",
          isbn: result.isbn,
          found: result.found,
          prefill: {
            title: result.title ?? "",
            authors: result.authors ?? "",
            coverUrl: result.coverUrl ?? null,
          },
        });
    } catch (e) {
      setError(errorMessage(e));
      setStep({ name: "start" });
    }
  };

  const titles: Record<Step["name"], string> = {
    start: "Add books",
    looking: "Looking up the book…",
    details: "Check the details",
    existing: "Already in the catalog",
    saved: "Book added",
  };

  return (
    <Layout title={titles[step.name]} back="/admin" focusKey={step.name}>
      <Alert>{error}</Alert>
      {step.name === "start" && (
        <StartStep
          camera={camera}
          setCamera={setCamera}
          onIsbn={lookUp}
          onNoIsbn={() =>
            setStep({
              name: "details",
              isbn: null,
              found: false,
              prefill: { title: "", authors: "", coverUrl: null },
            })
          }
        />
      )}
      {step.name === "looking" && <Loading label={`Looking up ISBN ${step.isbn}…`} />}
      {step.name === "details" && (
        <DetailsStep
          isbn={step.isbn}
          found={step.found}
          prefill={step.prefill}
          onCancel={() => setStep({ name: "start" })}
          onSaved={(title, added) =>
            setStep({
              name: "saved",
              title,
              added,
              newCopyIds: lastCopies(title, title.copies.length),
            })
          }
        />
      )}
      {step.name === "existing" && (
        <AddCopiesStep
          titleId={step.existing.id}
          heading={step.existing.title}
          detail={`${step.existing.copies} ${step.existing.copies === 1 ? "copy" : "copies"} already in the catalog.`}
          coverUrl={step.existing.coverUrl}
          onCancel={() => setStep({ name: "start" })}
          onSaved={(title, count) =>
            setStep({ name: "saved", title, added: false, newCopyIds: lastCopies(title, count) })
          }
        />
      )}
      {step.name === "saved" && (
        <SavedStep
          title={step.title}
          added={step.added}
          newCopyIds={step.newCopyIds}
          onNext={() => setStep({ name: "start" })}
        />
      )}
    </Layout>
  );
}

/** The newest `count` copies (copies are listed oldest first). */
function lastCopies(title: SavedTitle, count: number): string[] {
  return title.copies.slice(-count).map((c) => c.id);
}

function StartStep({
  camera,
  setCamera,
  onIsbn,
  onNoIsbn,
}: {
  camera: boolean;
  setCamera: (on: boolean) => void;
  onIsbn: (isbn: string) => void;
  onNoIsbn: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const isbn = normalizeIsbn(typed);
    if (!isbn) {
      setError(
        "That does not look like an ISBN. It is the 10 or 13 digits under the barcode, often starting 978.",
      );
      return;
    }
    onIsbn(isbn);
  };

  return (
    <div className="stack">
      <p className="lead">Scan the barcode on the back cover, or type the ISBN printed under it.</p>
      {camera ? (
        <>
          <Scanner
            label="Camera view for scanning a book barcode"
            hint="Point the camera at the barcode on the back cover"
            typeWhat="ISBN"
            formats={["ean_13"]}
            accept={(value) => normalizeIsbn(value)}
            onScan={onIsbn}
          />
          <Button variant="secondary" className="btn--block" onClick={() => setCamera(false)}>
            Stop the camera
          </Button>
        </>
      ) : (
        <Button className="btn--block btn--big" onClick={() => setCamera(true)}>
          Scan a barcode
        </Button>
      )}
      <form onSubmit={submit} noValidate>
        <Field
          label="Or type the ISBN"
          inputMode="numeric"
          autoComplete="off"
          enterKeyHint="search"
          error={error}
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            if (error) setError("");
          }}
        />
        <Button type="submit" variant="secondary" className="btn--block">
          Look it up
        </Button>
      </form>
      <div className="card">
        <p>
          <strong>No barcode or ISBN?</strong> Handmade books, some board books and older books have
          none. You can still add them: each copy gets its own QR sticker.
        </p>
        <Button variant="secondary" onClick={onNoIsbn}>
          Type the details instead
        </Button>
      </div>
    </div>
  );
}

function DetailsStep(props: {
  isbn: string | null;
  found: boolean;
  prefill: { title: string; authors: string; coverUrl: string | null };
  onCancel: () => void;
  onSaved: (title: SavedTitle, added: boolean) => void;
}) {
  const { isbn, found, prefill, onCancel, onSaved } = props;
  const [form, setForm] = useState({ title: prefill.title, authors: prefill.authors, copies: "1" });
  const [errors, setErrors] = useState<{ title?: string; copies?: string }>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const copiesInput = useRef<HTMLInputElement>(null);

  // When the details were not found online, start typing the title straight away.
  useEffect(() => {
    if (!found) titleInput.current?.focus();
  }, [found]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const copies = Number(form.copies);
    const problems: typeof errors = {};
    if (!form.title.trim()) problems.title = "Type the book's title.";
    if (!Number.isInteger(copies) || copies < 1 || copies > 20)
      problems.copies = "Enter a number from 1 to 20.";
    setErrors(problems);
    if (problems.title) return titleInput.current?.focus();
    if (problems.copies) return copiesInput.current?.focus();
    setBusy(true);
    setError("");
    try {
      const res = await api<{ title: SavedTitle; added: boolean }>("/catalog/titles", {
        body: {
          isbn: isbn ?? "",
          title: form.title,
          authors: form.authors,
          coverUrl: prefill.coverUrl ?? "",
          copies,
        },
      });
      onSaved(res.title, res.added);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} noValidate className="stack">
      {isbn && !found && (
        <Alert kind="info">
          <span id="not-found">
            We couldn't find ISBN {isbn} online. Type the title (and author, if you like) and it
            will be added with this ISBN.
          </span>
        </Alert>
      )}
      <Alert>{error}</Alert>
      <div className="book-preview">
        <Cover url={prefill.coverUrl} title={form.title} />
        <div>
          {isbn && <p className="muted">ISBN {isbn}</p>}
          {found && <p className="muted">Details found online. Fix anything that's wrong.</p>}
        </div>
      </div>
      <Field
        ref={titleInput}
        label="Title"
        describedBy={isbn && !found ? "not-found" : undefined}
        required
        maxLength={200}
        autoComplete="off"
        error={errors.title}
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
      />
      {!isbn && <SimilarTitles query={form.title} />}
      <Field
        label="Author (optional)"
        hint="Separate several authors with commas."
        maxLength={300}
        autoComplete="off"
        value={form.authors}
        onChange={(e) => setForm({ ...form, authors: e.target.value })}
      />
      <Field
        ref={copiesInput}
        label="How many copies?"
        hint="Each copy gets its own sticker."
        onWheel={(e) => e.currentTarget.blur()}
        type="number"
        inputMode="numeric"
        min={1}
        max={20}
        error={errors.copies}
        value={form.copies}
        onChange={(e) => setForm({ ...form, copies: e.target.value })}
      />
      <div className="row">
        <Button type="submit" busy={busy} busyLabel="Saving…">
          Add to the catalog
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** While typing a book with no ISBN, show matches already in the catalog to avoid a duplicate. */
function SimilarTitles({ query }: { query: string }) {
  const [matches, setMatches] = useState<{ id: string; title: string; copies: number }[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setMatches([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<{ titles: { id: string; title: string; copies: number }[] }>(
        `/catalog/titles?q=${encodeURIComponent(q)}`,
        { signal: controller.signal },
      )
        .then((res) => setMatches(res.titles.slice(0, 5)))
        .catch(() => setMatches([]));
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  if (matches.length === 0) return null;
  return (
    <div className="alert alert--info">
      <p style={{ margin: "0 0 0.5rem" }} aria-live="polite">
        Already in the catalog? Add copies to it instead of adding it twice:
      </p>
      <ul className="list">
        {matches.map((m) => (
          <li key={m.id}>
            <span>
              {m.title}{" "}
              <span className="muted">
                · {m.copies} {m.copies === 1 ? "copy" : "copies"}
              </span>
            </span>
            <Link href={`/admin/catalog/${m.id}?add=1`}>Add copies to this one</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AddCopiesStep(props: {
  titleId: string;
  heading: string;
  detail: string;
  coverUrl: string | null;
  onCancel: () => void;
  onSaved: (title: SavedTitle, count: number) => void;
}) {
  const [count, setCount] = useState("1");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      setError("Enter a number from 1 to 20.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await api<{ title: SavedTitle }>(`/catalog/titles/${props.titleId}/copies`, {
        body: { count: n },
      });
      props.onSaved(res.title, n);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} noValidate className="stack">
      <div className="book-preview">
        <Cover url={props.coverUrl} title={props.heading} />
        <div>
          <p>
            <strong>{props.heading}</strong>
          </p>
          <p className="muted">{props.detail}</p>
        </div>
      </div>
      <Field
        label="How many more copies?"
        onWheel={(e) => e.currentTarget.blur()}
        type="number"
        inputMode="numeric"
        min={1}
        max={20}
        error={error}
        value={count}
        onChange={(e) => setCount(e.target.value)}
      />
      <div className="row">
        <Button type="submit" busy={busy} busyLabel="Adding…">
          Add copies
        </Button>
        <Button variant="secondary" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SavedStep(props: {
  title: SavedTitle;
  added: boolean;
  newCopyIds: string[];
  onNext: () => void;
}) {
  const codes = props.title.copies
    .filter((c) => props.newCopyIds.includes(c.id))
    .map((c) => c.shortCode);
  return (
    <div className="stack">
      <Alert kind="success">
        {props.added ? "Added" : "Added more copies of"} <strong>{props.title.title}</strong>. New{" "}
        {codes.length === 1 ? "copy code" : "copy codes"}:{" "}
        {codes.map((code, i) => (
          <span key={code}>
            {i > 0 && ", "}
            <strong className="code">{code}</strong>
          </span>
        ))}
        . <Link href={`/admin/catalog/${props.title.id}`}>View in the catalog</Link>
      </Alert>
      <p>Stick a QR label inside each copy's front cover so parents can scan it.</p>
      <div className="row">
        <Button onClick={() => navigate(`/admin/labels?ids=${props.newCopyIds.join(",")}`)}>
          Print {codes.length === 1 ? "its label" : "their labels"}
        </Button>
        <Button variant="secondary" onClick={props.onNext}>
          Add another book
        </Button>
      </div>
      <p className="muted">
        Or print later: <Link href="/admin/labels">Print labels</Link> lists every copy that still
        needs one.
      </p>
    </div>
  );
}
