import { useEffect, useState } from "react";
import { Alert, Button, Layout, Loading } from "../components.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { formatDate } from "../lib/copies.ts";
import { Link, useLocation } from "../lib/router.tsx";

/**
 * "Keep it longer" from a reminder email. Works without signing in (the link
 * is signed). Opening the page changes nothing: the book is extended only
 * when the button is pressed, so an email scanner following the link can't
 * do it by itself.
 */
export function ExtendPage() {
  const { query } = useLocation();
  const l = query.get("l") ?? "";
  const t = query.get("t") ?? "";
  const [book, setBook] = useState<{ title: string; dueOn: string } | null>(null);
  const [state, setState] = useState<"loading" | "ask" | "busy" | "done" | "spent">("loading");
  const [done, setDone] = useState<{ dueOn: string; slug: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ title: string; dueOn: string }>(
      `/extend-by-link?l=${encodeURIComponent(l)}&t=${encodeURIComponent(t)}`,
    )
      .then((found) => {
        setBook(found);
        setState("ask");
      })
      .catch((e) => {
        setError(errorMessage(e));
        setState("spent");
      });
  }, [l, t]);

  const extend = async () => {
    setState("busy");
    setError("");
    try {
      const res = await api<{ dueOn: string; library: { slug: string } }>("/extend-by-link", {
        body: { l, t },
      });
      setDone({ dueOn: res.dueOn, slug: res.library.slug });
      setState("done");
    } catch (e) {
      setError(errorMessage(e));
      setState("ask");
    }
  };

  const title =
    state === "done"
      ? "Kept longer"
      : state === "spent"
        ? "This link can't be used"
        : "Keep the book longer?";
  return (
    <Layout title={title} focusKey={state} siteWide>
      <Alert>{error}</Alert>
      {state === "loading" && <Loading label="Finding the book…" />}
      {done && book && (
        <p className="lead">
          Done. <strong>{book.title}</strong> is now due back{" "}
          <strong>{formatDate(done.dueOn)}</strong>.
        </p>
      )}
      {(state === "ask" || state === "busy") && book && (
        <>
          <p className="lead">
            Keep <strong>{book.title}</strong> for another loan period? It's due back{" "}
            {formatDate(book.dueOn)} now.
          </p>
          <Button onClick={extend} busy={state === "busy"} busyLabel="Extending…">
            Keep it longer
          </Button>
        </>
      )}
      <p style={{ marginTop: "1.5rem" }}>
        <Link href={done ? `/${done.slug}` : "/"} absolute>
          Open the library
        </Link>
      </p>
    </Layout>
  );
}
