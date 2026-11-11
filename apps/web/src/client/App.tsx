import { type ReactNode, useEffect, useState } from "react";
import { Alert, Button, Layout, LoadingPage } from "./components.tsx";
import { Link, navigate, useLocation } from "./lib/router.tsx";
import { type Me, SessionProvider, useSession } from "./lib/session.tsx";
import { AccountPage } from "./pages/Account.tsx";
import { HomePage } from "./pages/Home.tsx";
import { SetupPage } from "./pages/Setup.tsx";
import { SignInPage } from "./pages/SignIn.tsx";

export function App() {
  return (
    <SessionProvider>
      <Routes />
    </SessionProvider>
  );
}

/** Sends someone elsewhere after render (never during it). */
function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return <LoadingPage />;
}

function signInPath(path: string, search: string) {
  return `/signin?next=${encodeURIComponent(path + search)}`;
}

function Routes() {
  const { state, refresh } = useSession();
  const { path } = useLocation();

  if (state.status === "loading") return <LoadingPage label="Opening the library…" />;
  if (state.status === "error") return <Unavailable message={state.message} retry={refresh} />;
  const me = state.me;

  if (path === "/signin") return me.user ? <Redirect to="/" /> : <SignInPage />;

  const guard = (page: ReactNode, rule: (me: Me) => boolean = () => true) => {
    if (!me.user) return <Redirect to={signInPath(path, window.location.search)} />;
    if (me.setupNeeded && path !== "/setup") return <Redirect to="/setup" />;
    if (!rule(me)) return <NotAllowed />;
    return page;
  };

  if (path === "/setup") {
    if (!me.setupNeeded) return <Redirect to="/" />;
    return guard(<SetupPage />);
  }
  if (path === "/account") return guard(<AccountPage />);
  if (path === "/") return guard(<HomePage />);
  return <NotFound />;
}

function NotAllowed() {
  return (
    <Layout title="Staff only">
      <p>This page is for library staff. Ask the library's admin if you need access.</p>
      <p>
        <Link href="/">Go to your books</Link>
      </p>
    </Layout>
  );
}

function NotFound() {
  return (
    <Layout title="Page not found">
      <p>That page does not exist. The link may be old or mistyped.</p>
      <p>
        <Link href="/">Go to the home page</Link>
      </p>
    </Layout>
  );
}

function Unavailable({ message, retry }: { message: string; retry: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Layout title="The library is unavailable">
      <Alert>{message}</Alert>
      <Button
        busy={busy}
        busyLabel="Trying again…"
        onClick={async () => {
          setBusy(true);
          await retry();
          setBusy(false);
        }}
      >
        Try again
      </Button>
    </Layout>
  );
}
