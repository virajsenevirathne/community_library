import { Alert, Layout } from "../components.tsx";
import { useSession } from "../lib/session.tsx";

/** A parent's home: their family's books. Filled in by the borrow and return step. */
export function HomePage() {
  const { state } = useSession();
  const me = state.status === "ready" ? state.me : null;
  const membership = me?.membership;

  return (
    <Layout title="Your books">
      {!membership && (
        <Alert kind="info">
          You're signed in, but not part of this library yet. Ask staff for the sign-up link or an
          invite.
        </Alert>
      )}
      {membership?.family?.status === "pending" && (
        <Alert kind="info">
          Thanks for joining. Staff will approve your family soon, then you can borrow.
        </Alert>
      )}
      <p className="lead">
        To borrow or return a book, scan the QR sticker inside its cover with your phone camera.
      </p>
    </Layout>
  );
}
