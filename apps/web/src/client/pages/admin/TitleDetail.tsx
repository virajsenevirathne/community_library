import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Alert, Button, Field, Layout, Loading } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { navigate, useLocation } from "../../lib/router.tsx";
import { AddCopiesStep } from "./AddBooks.tsx";
import { Cover } from "./Cover.tsx";

interface Copy {
  id: string;
  shortCode: string;
  status: "available" | "on_loan" | "lost" | "damaged" | "retired";
  shelf: string | null;
  note: string | null;
  dueOn: string | null;
  labelPrinted: boolean;
  found: boolean;
}

interface Title {
  id: string;
  isbn: string | null;
  title: string;
  authors: string;
  coverUrl: string | null;
  copies: Copy[];
}

const STATUS_LABELS: Record<Copy["status"], string> = {
  available: "On the shelf",
  on_loan: "On loan",
  lost: "Lost",
  damaged: "Damaged",
  retired: "Retired",
};

const DATE = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});
const formatDue = (date: string) => DATE.format(new Date(`${date}T12:00:00`));

export function TitleDetailPage({ id }: { id: string }) {
  const [title, setTitle] = useState<Title | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { query } = useLocation();
  const [mode, setMode] = useState<"view" | "edit" | "add">(query.get("add") ? "add" : "view");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTitle((await api<{ title: Title }>(`/catalog/titles/${id}`)).title);
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!title) {
    return (
      <Layout title="Book" back="/admin/catalog">
        {error ? (
          <>
            <Alert>{error}</Alert>
            <Button
              variant="secondary"
              onClick={() => void load()}
              busy={loading}
              busyLabel="Trying again…"
            >
              Try again
            </Button>
          </>
        ) : (
          <Loading />
        )}
      </Layout>
    );
  }

  const unlabelled = title.copies.filter((c) => !c.labelPrinted && c.status !== "retired");

  return (
    <Layout title={title.title} back="/admin/catalog" focusKey={mode}>
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>
      {mode === "edit" ? (
        <EditTitle
          title={title}
          onDone={(updated) => {
            if (updated) {
              setTitle(updated);
              setNotice("Saved.");
            }
            setMode("view");
          }}
        />
      ) : mode === "add" ? (
        <AddCopiesStep
          titleId={title.id}
          heading={title.title}
          detail={`${title.copies.length} ${title.copies.length === 1 ? "copy" : "copies"} so far.`}
          coverUrl={title.coverUrl}
          onCancel={() => setMode("view")}
          onSaved={(saved, count) => {
            const ids = saved.copies.slice(-count).map((c) => c.id);
            navigate(`/admin/labels?ids=${ids.join(",")}`);
          }}
        />
      ) : (
        <>
          <div className="book-preview">
            <Cover url={title.coverUrl} title={title.title} />
            <div>
              {title.authors && <p>{title.authors}</p>}
              <p className="muted">{title.isbn ? `ISBN ${title.isbn}` : "No ISBN"}</p>
            </div>
          </div>
          <div className="btn-grid">
            {unlabelled.length > 0 && (
              <Button
                onClick={() =>
                  navigate(`/admin/labels?ids=${unlabelled.map((c) => c.id).join(",")}`)
                }
              >
                Print {unlabelled.length} {unlabelled.length === 1 ? "label" : "labels"}
              </Button>
            )}
            <Button variant="secondary" onClick={() => setMode("edit")}>
              Edit details
            </Button>
            <Button variant="secondary" onClick={() => setMode("add")}>
              Add copies
            </Button>
          </div>
          <h2>
            Copies <span className="muted">({title.copies.length})</span>
          </h2>
          <ul className="copy-list">
            {title.copies.map((copy) => (
              <CopyRow
                key={copy.id}
                copy={copy}
                onChanged={(updated, message) => {
                  setTitle(updated);
                  setNotice(message);
                  setError("");
                }}
                onError={setError}
              />
            ))}
          </ul>
        </>
      )}
    </Layout>
  );
}

const CONFIRM: Partial<Record<Copy["status"], string>> = {
  lost: "Mark copy {code} as lost? It will no longer be offered for borrowing.",
  retired:
    "Retire copy {code}? Do this when the book is worn out or given away. It stays in the history.",
};

function CopyRow({
  copy,
  onChanged,
  onError,
}: {
  copy: Copy;
  onChanged: (title: Title, message: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  // The new status is chosen first and applied with Save, so arrow keys or a
  // mis-tap on the list cannot change a copy by accident.
  const [choice, setChoice] = useState<Copy["status"]>(copy.status);
  useEffect(() => setChoice(copy.status), [copy.status]);

  const save = async () => {
    const confirmText = CONFIRM[choice];
    if (confirmText && !confirm(confirmText.replace("{code}", copy.shortCode))) return;
    setBusy(true);
    try {
      const res = await api<{ title: Title }>(`/catalog/copies/${copy.id}`, {
        method: "PATCH",
        body: { status: choice },
      });
      onChanged(res.title, `Copy ${copy.shortCode} is now “${STATUS_LABELS[choice]}”.`);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const reprint = async () => {
    setBusy(true);
    try {
      const res = await api<{ title: Title }>(`/catalog/copies/${copy.id}`, {
        method: "PATCH",
        body: { needsLabel: true },
      });
      onChanged(res.title, `Copy ${copy.shortCode} is on the list to print a new label.`);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const onLoan = copy.status === "on_loan";
  return (
    <li className="copy-row">
      <div className="copy-row__main">
        <span className="row row--tight">
          <strong className="code">{copy.shortCode}</strong>
          {/* Copies off loan show their status in the dropdown instead. */}
          {onLoan && <span className="badge badge--on_loan">{STATUS_LABELS.on_loan}</span>}
          {copy.found && <span className="badge badge--found">Reported found</span>}
          {!copy.labelPrinted && copy.status !== "retired" && (
            <span className="badge badge--warn">Needs a label</span>
          )}
        </span>
        {(onLoan && copy.dueOn) || copy.note ? (
          <span className="muted">
            {onLoan && copy.dueOn && `Due ${formatDue(copy.dueOn)}`}
            {onLoan && copy.dueOn && copy.note && " · "}
            {copy.note}
          </span>
        ) : null}
        {onLoan && (
          <span className="copy-row__hint">
            To change its status, return it first (or mark the loan lost from Loans).
          </span>
        )}
      </div>
      <div className="copy-row__actions">
        {copy.labelPrinted && copy.status !== "retired" && (
          <Button
            variant="secondary"
            onClick={reprint}
            busy={busy}
            aria-label={`Copy ${copy.shortCode} needs a new label`}
          >
            Needs a new label
          </Button>
        )}
        {!onLoan && (
          <>
            <label className="inline-select">
              <span className="visually-hidden">New status for copy {copy.shortCode}</span>
              <select
                value={choice}
                disabled={busy}
                onChange={(e) => setChoice(e.target.value as Copy["status"])}
              >
                <option value="available">On the shelf</option>
                <option value="damaged">Damaged</option>
                <option value="lost">Lost</option>
                <option value="retired">Retired</option>
              </select>
            </label>
            {choice !== copy.status && (
              <Button
                onClick={save}
                busy={busy}
                busyLabel="Saving…"
                aria-label={`Save status of copy ${copy.shortCode}`}
              >
                Save
              </Button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function EditTitle({ title, onDone }: { title: Title; onDone: (updated: Title | null) => void }) {
  const [form, setForm] = useState({ title: title.title, authors: title.authors });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim()) {
      setError("Type the book's title.");
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ title: Title }>(`/catalog/titles/${title.id}`, {
        method: "PATCH",
        body: form,
      });
      onDone(res.title);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} noValidate>
      <Field
        label="Title"
        required
        maxLength={200}
        error={error}
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
      />
      <Field
        label="Author (optional)"
        maxLength={300}
        value={form.authors}
        onChange={(e) => setForm({ ...form, authors: e.target.value })}
      />
      <div className="row">
        <Button type="submit" busy={busy} busyLabel="Saving…">
          Save
        </Button>
        <Button variant="secondary" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
