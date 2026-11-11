import { useState } from "react";
import { Alert, Button, Layout } from "../components.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { Link, useLocation } from "../lib/router.tsx";

/**
 * Opened from the link in a reminder email. Asks before turning reminders
 * off, so an email scanner following the link cannot do it by itself.
 */
export function RemindersOffPage() {
  const { query } = useLocation();
  const [state, setState] = useState<"ask" | "busy" | "done">("ask");
  const [error, setError] = useState("");

  const turnOff = async () => {
    setState("busy");
    setError("");
    try {
      await api("/reminders-off", { body: { f: query.get("f") ?? "", t: query.get("t") ?? "" } });
      setState("done");
    } catch (e) {
      setError(errorMessage(e));
      setState("ask");
    }
  };

  return (
    <Layout title={state === "done" ? "Reminders turned off" : "Turn off reminder emails?"}>
      <Alert>{error}</Alert>
      {state === "done" ? (
        <p className="lead">
          Done. Your family won't get due-date reminders any more. You'll still get an email
          whenever you borrow a book, listing everything you have out. To turn reminders back on, go
          to Account in the library.
        </p>
      ) : (
        <>
          <p className="lead">
            Your family will stop getting due-date and overdue reminders. You'll still get an email
            each time you borrow.
          </p>
          <Button onClick={turnOff} busy={state === "busy"} busyLabel="Turning off…">
            Turn off reminders
          </Button>
        </>
      )}
      <p style={{ marginTop: "1.5rem" }}>
        <Link href="/">Go to the library</Link>
      </p>
    </Layout>
  );
}
