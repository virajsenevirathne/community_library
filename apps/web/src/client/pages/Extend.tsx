import { useState } from "react";
import { Alert, Button, Layout } from "../components.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { formatDate } from "../lib/copies.ts";
import { Link, useLocation } from "../lib/router.tsx";

/**
 * "Keep it longer" from a reminder email. Works without signing in (the link
 * is signed), and asks first, so an email scanner following the link can't
 * extend the book by itself.
 */
export function ExtendPage() {
  const { query } = useLocation();
  const [state, setState] = useState<"ask" | "busy" | "done">("ask");
  const [done, setDone] = useState<{ title: string; dueOn: string; slug: string } | null>(null);
  const [error, setError] = useState("");

  const extend = async () => {
    setState("busy");
    setError("");
    try {
      const res = await api<{ title: string; dueOn: string; library: { slug: string } }>(
        "/extend-by-link",
        { body: { l: query.get("l") ?? "", t: query.get("t") ?? "" } },
      );
      setDone({ title: res.title, dueOn: res.dueOn, slug: res.library.slug });
      setState("done");
    } catch (e) {
      setError(errorMessage(e));
      setState("ask");
    }
  };

  return (
    <Layout title={done ? "Kept longer" : "Keep the book longer?"} siteWide>
      <Alert>{error}</Alert>
      {done ? (
        <p className="lead">
          Done. <strong>{done.title}</strong> is now due back{" "}
          <strong>{formatDate(done.dueOn)}</strong>.
        </p>
      ) : (
        <>
          <p className="lead">
            Keep the book from your reminder email for another loan period? You can do this once
            nobody else is waiting for it.
          </p>
          <Button onClick={extend} busy={state === "busy"} busyLabel="Extending…">
            Keep it longer
          </Button>
        </>
      )}
      <p style={{ marginTop: "1.5rem" }}>
        <Link href={done ? `/${done.slug}` : "/"} absolute>
          Go to the library
        </Link>
      </p>
    </Layout>
  );
}
