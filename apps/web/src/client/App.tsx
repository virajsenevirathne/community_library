import { type ReactNode, useEffect, useState } from "react";
import { Alert, Button, Layout, LoadingPage } from "./components.tsx";
import { Link, navigate, useLocation } from "./lib/router.tsx";
import { isStaff, type Me, SessionProvider, useSession } from "./lib/session.tsx";
import { AccountPage } from "./pages/Account.tsx";
import { AddBooksPage } from "./pages/admin/AddBooks.tsx";
import { AdminHomePage } from "./pages/admin/AdminHome.tsx";
import { BulkReturnPage } from "./pages/admin/BulkReturn.tsx";
import { CatalogPage } from "./pages/admin/Catalog.tsx";
import { LabelsPage } from "./pages/admin/Labels.tsx";
import { TitleDetailPage } from "./pages/admin/TitleDetail.tsx";
import { CodeEntryPage, CopyPage } from "./pages/Copy.tsx";
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

  const guard = (
    page: ReactNode,
    rule: (me: Me) => boolean = () => true,
    who: "staff" | "admin" = "staff",
  ) => {
    if (!me.user) return <Redirect to={signInPath(path, window.location.search)} />;
    if (me.setupNeeded && path !== "/setup") return <Redirect to="/setup" />;
    if (!rule(me)) return <NotAllowed who={who} />;
    return page;
  };

  if (path === "/setup") {
    if (!me.setupNeeded) return <Redirect to="/" />;
    return guard(<SetupPage />);
  }
  if (path === "/account") return guard(<AccountPage />);
  if (path === "/admin") return guard(<AdminHomePage />, isStaff);
  if (path === "/admin/add") return guard(<AddBooksPage />, isStaff);
  if (path === "/admin/catalog") return guard(<CatalogPage />, isStaff);
  if (path === "/admin/labels") return guard(<LabelsPage />, isStaff);
  if (path === "/admin/returns") return guard(<BulkReturnPage />, isStaff);
  if (path === "/c") return guard(<CodeEntryPage />);
  const copyMatch = path.match(/^\/c\/([A-Za-z0-9-]{1,12})\/?$/);
  if (copyMatch?.[1]) return guard(<CopyPage key={copyMatch[1]} code={copyMatch[1]} />);
  const titleMatch = path.match(/^\/admin\/catalog\/([\w-]+)$/);
  if (titleMatch?.[1])
    return guard(<TitleDetailPage key={titleMatch[1]} id={titleMatch[1]} />, isStaff);
  if (path === "/") return guard(<HomePage />);
  return <NotFound />;
}

function NotAllowed({ who }: { who: "staff" | "admin" }) {
  return (
    <Layout title={who === "admin" ? "Admin only" : "Staff only"}>
      <p>
        {who === "admin"
          ? "This page is only for the library admin."
          : "This page is only for library staff. If you need it, ask the library admin."}
      </p>
      <p>
        <Link href="/">Go to the home page</Link>
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
