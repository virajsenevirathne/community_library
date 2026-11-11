import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
} from "react";
import { hasNavigated, Link, useLocation } from "./lib/router.tsx";
import { isStaff, useSession } from "./lib/session.tsx";

/**
 * Page frame: header, skip link and a main area with the page title.
 * When the page or step changes (`title` or `focusKey`), the title gets focus
 * and the tab title updates, so screen readers announce where you are.
 */
export function Layout({
  title,
  children,
  back,
  focusKey,
}: {
  title: string;
  children: ReactNode;
  back?: string;
  focusKey?: string;
}) {
  const { state } = useSession();
  const { path } = useLocation();
  const me = state.status === "ready" ? state.me : null;
  const libraryName = me?.library?.name ?? "Community Library";
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    document.title = `${title} · ${libraryName}`;
  }, [title, libraryName]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: title and focusKey are deliberate triggers
  useEffect(() => {
    // On a fresh page load, leave focus where the browser put it.
    if (mounted.current || hasNavigated()) heading.current?.focus();
    mounted.current = true;
  }, [title, focusKey]);

  const skip = () => heading.current?.focus();

  const navItem = (href: string, label: string) => (
    <li>
      <Link href={href} aria-current={path.startsWith(href) ? "page" : undefined}>
        {label}
      </Link>
    </li>
  );

  return (
    <>
      <button type="button" className="skip-link" onClick={skip}>
        Skip to content
      </button>
      <header className="site-header">
        <div className="site-header__inner">
          <Link href="/" className="brand">
            {libraryName}
          </Link>
          {me?.user && (
            <nav aria-label="Main">
              <ul className="nav">
                {isStaff(me) && navItem("/admin", "Admin")}
                {navItem("/account", "Account")}
              </ul>
            </nav>
          )}
        </div>
      </header>
      <main id="main" className="page">
        {back && (
          <p className="back">
            <Link href={back}>← Back</Link>
          </p>
        )}
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        {children}
      </main>
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

export function Alert({
  kind = "error",
  children,
}: {
  kind?: "error" | "info" | "success";
  children: ReactNode;
}) {
  if (!children) return null;
  return (
    <div className={`alert alert--${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
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
