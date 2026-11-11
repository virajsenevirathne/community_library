import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
} from "react";
import { Icon } from "./icons.tsx";
import { hasNavigated, Link, useLocation } from "./lib/router.tsx";
import { isStaff, useSession } from "./lib/session.tsx";

/** True when `path` is `href` or a page inside it (so /admin/loans is inside /admin). */
function isCurrent(path: string, href: string, exact = false) {
  if (exact || href === "/") return path === href;
  return path === href || path.startsWith(`${href}/`);
}

/**
 * Page frame: header, navigation, skip link and a main area with the title.
 *
 * - `width`: "narrow" for reading and forms, "wide" for staff screens on a computer.
 * - `actions`: the page's main buttons, shown beside the title on wide screens.
 *
 * On phones the navigation moves to a bottom tab bar within thumb reach; on
 * computers, staff pages also get a row of tabs for moving between them.
 * When the page or step changes (`title` or `focusKey`), the title gets focus
 * and the tab title updates, so screen readers announce where you are.
 */
export function Layout({
  title,
  children,
  back,
  focusKey,
  width = "narrow",
  actions,
}: {
  title: string;
  children: ReactNode;
  back?: string;
  focusKey?: string;
  width?: "narrow" | "wide";
  actions?: ReactNode;
}) {
  const { state } = useSession();
  const { path } = useLocation();
  const me = state.status === "ready" ? state.me : null;
  const libraryName = me?.library?.name ?? "Community Library";
  const staff = me ? isStaff(me) : false;
  const admin = me?.membership?.role === "admin";
  const signedIn = Boolean(me?.user);
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    document.title = `${title} · ${libraryName}`;
  }, [title, libraryName]);

  // The bottom tab bar needs room at the end of every page.
  useEffect(() => {
    document.body.classList.toggle("has-tabbar", signedIn);
  }, [signedIn]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: title and focusKey are deliberate triggers
  useEffect(() => {
    // On a fresh page load, leave focus where the browser put it.
    if (mounted.current || hasNavigated()) heading.current?.focus();
    mounted.current = true;
  }, [title, focusKey]);

  const skip = () => heading.current?.focus();
  const current = (href: string, exact = false) =>
    isCurrent(path, href, exact) ? ("page" as const) : undefined;

  const staffTabs: { href: string; label: string; exact?: boolean }[] = [
    { href: "/admin", label: "Dashboard", exact: true },
    { href: "/admin/loans", label: "Loans" },
    { href: "/admin/returns", label: "Check in returns" },
    { href: "/admin/catalog", label: "Catalog" },
    { href: "/admin/add", label: "Add books" },
    { href: "/admin/labels", label: "Labels" },
    { href: "/admin/families", label: "Families" },
    ...(admin ? [{ href: "/admin/settings", label: "Settings" }] : []),
  ];

  return (
    <>
      <button type="button" className="skip-link" onClick={skip}>
        Skip to content
      </button>
      <header className={`site-header${width === "narrow" ? " site-header--narrow" : ""}`}>
        <div className="site-header__inner">
          <Link href="/" className="brand" aria-label={`${libraryName}: home`}>
            <span className="brand__mark">
              <Icon name="book" className="brand__icon" />
            </span>
            <span className="brand__name">{libraryName}</span>
          </Link>
          {signedIn && (
            <nav aria-label="Main">
              <ul className="nav">
                <li>
                  <Link href="/" aria-current={current("/")}>
                    Your books
                  </Link>
                </li>
                {staff && (
                  <li>
                    <Link
                      href="/admin"
                      aria-current={path.startsWith("/admin") ? "page" : undefined}
                    >
                      Staff
                    </Link>
                  </li>
                )}
                <li>
                  <Link href="/account" aria-current={current("/account")}>
                    Account
                  </Link>
                </li>
              </ul>
            </nav>
          )}
        </div>
      </header>
      {staff && path.startsWith("/admin") && (
        <nav className="subnav" aria-label="Staff">
          <ul className="subnav__inner">
            {staffTabs.map((tab) => (
              <li key={tab.href}>
                <Link href={tab.href} aria-current={current(tab.href, tab.exact)}>
                  {tab.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <main id="main" className={`page page--${width}`}>
        {back && (
          <p className="back">
            <Link href={back}>← Back</Link>
          </p>
        )}
        {actions ? (
          <div className="page-header">
            <h1 ref={heading} tabIndex={-1}>
              {title}
            </h1>
            <div className="row">{actions}</div>
          </div>
        ) : (
          <h1 ref={heading} tabIndex={-1}>
            {title}
          </h1>
        )}
        {children}
      </main>
      {signedIn && (
        <nav aria-label="Main (phone)" className="tabbar-nav">
          <ul className="tabbar">
            <li>
              <Link href="/" aria-current={current("/")}>
                <Icon name="book" />
                Books
              </Link>
            </li>
            <li>
              <Link href="/c" aria-current={current("/c", true)}>
                <Icon name="scan" />
                Type a code
              </Link>
            </li>
            {staff && (
              <li>
                <Link href="/admin" aria-current={path.startsWith("/admin") ? "page" : undefined}>
                  <Icon name="grid" />
                  Staff
                </Link>
              </li>
            )}
            <li>
              <Link href="/account" aria-current={current("/account")}>
                <Icon name="user" />
                Account
              </Link>
            </li>
          </ul>
        </nav>
      )}
    </>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "link";
  /** Shows a spinner and ignores clicks, but keeps focus on the button. */
  busy?: boolean;
  /** What the button says while busy, such as "Sending…". */
  busyLabel?: string;
};

export function Button({
  variant = "primary",
  busy = false,
  busyLabel,
  children,
  disabled,
  className,
  onClick,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn btn--${variant}${className ? ` ${className}` : ""}`}
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={(event) => {
        // A busy button stays focusable (disabling it would drop focus) but does nothing.
        if (busy) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...rest}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  invalid,
  describedBy,
  ref,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string | undefined;
  /** Shown under the field and announced with it. */
  error?: string | undefined;
  /** Marks the field invalid when the error is shown elsewhere (such as an alert above). */
  invalid?: boolean | undefined;
  /** Ids of other elements that describe this field. */
  describedBy?: string | undefined;
  ref?: Ref<HTMLInputElement> | undefined;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      <input
        ref={ref}
        id={id}
        aria-invalid={error || invalid ? true : undefined}
        aria-describedby={[describedBy, hintId, errorId].filter(Boolean).join(" ") || undefined}
        {...input}
      />
      {error && (
        <p className="field__error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}

const ALERT_ICONS = {
  error: "error",
  warning: "warning",
  info: "info",
  success: "check",
} as const;

/**
 * A message box. "error" is for something that failed; "warning" for
 * something that needs attention soon; "info" and "success" are calm.
 */
export function Alert({
  kind = "error",
  children,
}: {
  kind?: "error" | "warning" | "info" | "success";
  children: ReactNode;
}) {
  if (!children) return null;
  return (
    <div className={`alert alert--${kind}`} role={kind === "error" ? "alert" : "status"}>
      <Icon name={ALERT_ICONS[kind]} className="alert__icon" />
      <div className="alert__body">{children}</div>
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="loading" role="status">
      <span className="spinner" aria-hidden="true" /> {label}
    </p>
  );
}

/** A whole-page loading state inside the usual page frame. */
export function LoadingPage({ label = "Loading…" }: { label?: string }) {
  return (
    <main id="main" className="page">
      <h1 className="visually-hidden">{label}</h1>
      <Loading label={label} />
    </main>
  );
}
