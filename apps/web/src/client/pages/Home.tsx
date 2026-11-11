import { Alert, Layout } from "../components.tsx";
import { Link } from "../lib/router.tsx";
import { isStaff, type Me, useSession } from "../lib/session.tsx";

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

/** A parent's home: their family's books. The list itself arrives with borrowing (VIR-11). */
export function HomePage() {
  const { state } = useSession();
  if (state.status !== "ready") return null;
  const me = state.me;
  const status = borrowState(me);

  return (
    <Layout title={status === "ok" || status === "pending" ? "Your books" : "Welcome"}>
      {status === "not_member" && (
        <Alert kind="info">
          You're signed in, but you haven't joined this library yet. Ask the library staff for the
          sign-up link or an invite.
        </Alert>
      )}
      {status === "pending" && (
        <Alert kind="info">
          Your family is waiting for staff approval. You can borrow once they approve it. Ask staff
          if it's taking a while.
        </Alert>
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
      {status === "ok" && (
        <p className="lead">
          To borrow or return a book, scan the QR sticker inside its cover with your phone camera.
        </p>
      )}
      {status === "pending" && (
        <p className="lead">
          Once you're approved, scan the QR sticker inside a book's cover to borrow it.
        </p>
      )}
    </Layout>
  );
}
