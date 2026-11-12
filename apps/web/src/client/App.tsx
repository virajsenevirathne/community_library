import { type ReactNode, useEffect, useState } from "react";
import { Alert, Button, Layout, LibraryList, LoadingPage } from "./components.tsx";
import { Link, navigate, safeNext, useLocation } from "./lib/router.tsx";
import { isStaff, type LibraryLink, type Me, SessionProvider, useSession } from "./lib/session.tsx";
import { storedTheme, useTheme } from "./lib/theme.ts";
import { AccountPage } from "./pages/Account.tsx";
import { AddBooksPage } from "./pages/admin/AddBooks.tsx";
import { AdminHomePage } from "./pages/admin/AdminHome.tsx";
import { BulkReturnPage } from "./pages/admin/BulkReturn.tsx";
import { CatalogPage } from "./pages/admin/Catalog.tsx";
import { FamiliesPage } from "./pages/admin/Families.tsx";
import { ImportPage } from "./pages/admin/Import.tsx";
import { LabelsPage } from "./pages/admin/Labels.tsx";
import { LoansPage } from "./pages/admin/Loans.tsx";
import { SettingsPage } from "./pages/admin/Settings.tsx";
import { TitleDetailPage } from "./pages/admin/TitleDetail.tsx";
import { WelcomePage } from "./pages/admin/Welcome.tsx";
import { CodeEntryPage, CopyPage } from "./pages/Copy.tsx";
import { ExtendPage } from "./pages/Extend.tsx";
import { HomePage } from "./pages/Home.tsx";
import { InvitePage, JoinPage } from "./pages/Join.tsx";
import { KioskPage } from "./pages/Kiosk.tsx";
import { OwnerPage } from "./pages/Owner.tsx";
import { FrontPage, PrivacyPage, TermsPage } from "./pages/Public.tsx";
import { RemindersOffPage } from "./pages/RemindersOff.tsx";
import { SetupPage } from "./pages/Setup.tsx";
import { isFinishingSignIn, SignInPage } from "./pages/SignIn.tsx";

export function App() {
  return (
    <SessionProvider>
      <Routes />
    </SessionProvider>
  );
}

/** Sends someone elsewhere after render (never during it). */
function Redirect({ to, absolute = false }: { to: string; absolute?: boolean }) {
  useEffect(() => navigate(to, { replace: true, absolute }), [to, absolute]);
  return <LoadingPage />;
}

/** The full current address, so sign-in can bring the person back to it. */
function signInPath() {
  const here = window.location.pathname + window.location.search;
  return `/signin?next=${encodeURIComponent(here)}`;
}

function Routes() {
  const { state, refresh } = useSession();
  const { path, base } = useLocation();
  useTheme(
    // While the library's details load (or the page moves to another
    // library), keep the colour last seen for it, so nothing flashes green.
    state.status === "ready" && state.me.library?.slug === base
      ? state.me.library?.theme
      : storedTheme(base),
    base,
    // The kiosk sets its own library's colour.
    !(base && path === "/kiosk"),
  );

  // A kiosk tablet has its own pass, not a person's sign-in, so it doesn't
  // wait for (or depend on) the session.
  if (base && path === "/kiosk") return <KioskPage />;
  if (state.status === "loading") return <LoadingPage label="Opening the library…" />;
  if (state.status === "error") return <Unavailable message={state.message} retry={refresh} />;
  const me = state.me;

  // ---- Site-wide pages: the same for every library.
  if (!base) {
    if (path === "/privacy") return <PrivacyPage />;
    if (path === "/terms") return <TermsPage />;
    // The front page, also for people who are signed in.
    if (path === "/about") return <FrontPage />;
    // Signed out, the home page is the front page, with sign-in at the top.
    // While sign-in finishes (the passkey offer), its page stays put.
    const signingIn = isFinishingSignIn();
    if (path === "/" && (!me.user || signingIn)) return <FrontPage />;
    if (path === "/signin") {
      return me.user && !signingIn ? (
        <Redirect to={safeNext(new URLSearchParams(window.location.search).get("next"))} absolute />
      ) : (
        <SignInPage />
      );
    }
    // Opened from an email; works without signing in (the link is signed).
    if (path === "/reminders-off") return <RemindersOffPage />;
    if (path === "/extend") return <ExtendPage />;
    // Sign-up and invite links name their own library, and lead to sign-in themselves.
    const joinMatch = path.match(/^\/join\/([0-9a-f]{32})$/);
    if (joinMatch?.[1]) return <JoinPage token={joinMatch[1]} />;
    const inviteMatch = path.match(/^\/invite\/([\w-]{20,100})$/);
    if (inviteMatch?.[1]) return <InvitePage token={inviteMatch[1]} />;
  }

  if (!me.user) return <Redirect to={signInPath()} absolute />;
  if (me.setupNeeded && path !== "/setup") return <Redirect to="/setup" absolute />;

  if (!base) {
    if (path === "/setup") return me.setupNeeded ? <SetupPage /> : <Redirect to="/" />;
    if (path === "/account") return <AccountPage />;
    if (path === "/owner") return me.owner ? <OwnerPage /> : <NotFound />;
    // A book's QR code: the book names its library, and its page moves there.
    if (path === "/c") return <CodeEntryPage />;
    const copyMatch = path.match(/^\/c\/([A-Za-z0-9-]{1,12})\/?$/);
    if (copyMatch?.[1]) return <CopyPage key={copyMatch[1]} code={copyMatch[1]} />;
    // The home page and old library links (/admin/...): into the person's library.
    if (path === "/" || path === "/admin" || path.startsWith("/admin/")) {
      const only = me.libraries.length === 1 ? me.libraries[0] : undefined;
      const rest = `${path}${window.location.search}${window.location.hash}`;
      if (only) return <Redirect to={`/${only.slug}${rest}`} absolute />;
      if (me.libraries.length > 1) return <LibraryPicker libraries={me.libraries} rest={rest} />;
      // The site's owner, before any library of their own: their libraries page.
      if (me.owner && path === "/") return <Redirect to="/owner" absolute />;
      return <HomePage />;
    }
    return <NotFound />;
  }

  // ---- A library's pages, under /<slug>/.
  // Just moved here: wait for this library's answer before judging it.
  if (state.base !== base) return <LoadingPage label="Opening the library…" />;
  if (!me.library) return <NotFound what="library" />;
  // Moving between libraries: wait for this one's details.
  if (me.library.slug !== base) return <LoadingPage label="Opening the library…" />;

  const guard = (
    page: ReactNode,
    rule: (me: Me) => boolean = () => true,
    who: "staff" | "admin" = "staff",
  ) => (rule(me) ? page : <NotAllowed who={who} />);

  // A new library's admin finishes setting it up before anything else.
  const isAdmin = me.membership?.role === "admin";
  if (!me.library.setUp && isAdmin && !me.library.support && path !== "/account") {
    return <WelcomePage />;
  }

  if (path === "/admin") return guard(<AdminHomePage />, isStaff);
  if (path === "/admin/add") return guard(<AddBooksPage />, isStaff);
  if (path === "/admin/catalog") return guard(<CatalogPage />, isStaff);
  if (path === "/admin/labels") return guard(<LabelsPage />, isStaff);
  if (path === "/admin/returns") return guard(<BulkReturnPage />, isStaff);
  if (path === "/admin/loans") return guard(<LoansPage />, isStaff);
  if (path === "/admin/families") return guard(<FamiliesPage />, isStaff);
  if (path === "/admin/families/import") return guard(<ImportPage />, isStaff);
  if (path === "/admin/settings") {
    return guard(<SettingsPage />, (m) => m.membership?.role === "admin", "admin");
  }
  if (path === "/account") return <AccountPage />;
  if (path === "/c") return <CodeEntryPage />;
  const copyMatch = path.match(/^\/c\/([A-Za-z0-9-]{1,12})\/?$/);
  if (copyMatch?.[1]) return <CopyPage key={copyMatch[1]} code={copyMatch[1]} />;
  const titleMatch = path.match(/^\/admin\/catalog\/([\w-]+)$/);
  if (titleMatch?.[1])
    return guard(<TitleDetailPage key={titleMatch[1]} id={titleMatch[1]} />, isStaff);
  if (path === "/") return <HomePage />;
  return <NotFound />;
}

/** For people in more than one library: choose where to go. */
function LibraryPicker({ libraries, rest }: { libraries: LibraryLink[]; rest: string }) {
  return (
    <Layout title="Choose a library" siteWide>
      <p className="lead">Which library do you want to open?</p>
      <LibraryList libraries={libraries} rest={rest} />
    </Layout>
  );
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

function NotFound({ what = "page" }: { what?: "page" | "library" }) {
  const { state } = useSession();
  const libraries = state.status === "ready" ? state.me.libraries : [];
  if (what === "library") {
    const slug = window.location.pathname.split("/")[1] ?? "";
    return (
      <Layout title="Library not found" siteWide>
        <p>
          There's no library at <span className="code">/{slug}</span>. Check the link, or ask your
          library for it.
        </p>
        <Link href="/" absolute className="btn btn--primary">
          {libraries.length > 0 ? "See your libraries" : "Go to the home page"}
        </Link>
      </Layout>
    );
  }
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
