import { type FormEvent, useEffect, useRef, useState } from "react";
import { Alert, Button, Field, Layout, Loading } from "../components.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { authClient, forgetTokens, rememberToken } from "../lib/auth.ts";
import { Link, navigate } from "../lib/router.tsx";
import { useSession } from "../lib/session.tsx";

/** Opened from the library's sign-up link or QR code. */
export function JoinPage({ token }: { token: string }) {
  const { state, refresh } = useSession();
  const me = state.status === "ready" ? state.me : null;
  const [info, setInfo] = useState<{
    library: { name: string; slug: string };
    requireApproval: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [firstName, setFirstName] = useState(me?.user?.name ?? "");
  const [fieldError, setFieldError] = useState("");
  const [firstNameError, setFirstNameError] = useState("");
  const [busy, setBusy] = useState(false);
  const firstInput = useRef<HTMLInputElement>(null);
  const familyInput = useRef<HTMLInputElement>(null);

  // The session may load after this page: fill in a name we already know.
  const knownName = me?.user?.name ?? "";
  useEffect(() => {
    if (knownName) setFirstName((current) => current || knownName);
  }, [knownName]);

  useEffect(() => {
    api<{ library: { name: string; slug: string }; requireApproval: boolean }>(
      `/join/${encodeURIComponent(token)}`,
    )
      .then((res) => {
        setInfo(res);
        // Lets the sign-in page send this newcomer a code.
        rememberToken("join", token);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [token]);

  const join = async (event: FormEvent) => {
    event.preventDefault();
    const missingFirst = !firstName.trim();
    const missingFamily = !familyName.trim();
    if (missingFirst) setFirstNameError("Type your first name.");
    if (missingFamily) setFieldError("Type your family name, for example your surname.");
    if (missingFirst) firstInput.current?.focus();
    else if (missingFamily) familyInput.current?.focus();
    if (missingFirst || missingFamily) return;
    setBusy(true);
    setError("");
    try {
      await api("/join", { body: { token, familyName, firstName } });
      forgetTokens();
      await refresh();
      navigate(info?.library.slug ? `/${info.library.slug}/?joined=1` : "/?joined=1", {
        replace: true,
        absolute: true,
      });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  if (!info) {
    return (
      <Layout title={error ? "This sign-up link isn't active" : "Opening the sign-up page…"}>
        {error ? (
          <Alert kind="info">
            This sign-up link is no longer active. Please ask your library for the current link or
            QR code.
          </Alert>
        ) : (
          <Loading />
        )}
      </Layout>
    );
  }

  if (!me?.user) {
    return (
      <Layout title={`Join ${info.library.name}`}>
        <p className="lead">
          Borrow books for your family by scanning the sticker inside each one.
        </p>
        <p>
          <strong>Step 1 of 2:</strong> sign in with an email address you check. We'll email you a
          6-digit code: no password needed. Then you'll type your name.
        </p>
        <Button
          className="btn--block"
          onClick={() => navigate(`/signin?next=${encodeURIComponent(`/join/${token}`)}`)}
        >
          Continue with my email
        </Button>
      </Layout>
    );
  }

  if (me.membership) {
    return (
      <Layout title="You're already a member">
        <p>
          You're already part of {info.library.name}. <Link href="/">Go to your books</Link>
        </p>
      </Layout>
    );
  }

  return (
    <Layout title={`Join ${info.library.name}`}>
      <Alert>{error}</Alert>
      <p>
        <strong>Step 2 of 2:</strong> your name.
      </p>
      <form onSubmit={join} noValidate className="stack">
        <Field
          ref={firstInput}
          label="Your first name"
          hint="So staff know who's who in your family."
          autoComplete="given-name"
          maxLength={40}
          error={firstNameError}
          value={firstName}
          onChange={(e) => {
            setFirstName(e.target.value);
            setFirstNameError("");
          }}
        />
        <Field
          ref={familyInput}
          label="Family name"
          hint="What staff will know your family by, for example your surname. Nothing about your children is needed."
          autoComplete="family-name"
          maxLength={60}
          error={fieldError}
          value={familyName}
          onChange={(e) => {
            setFamilyName(e.target.value);
            setFieldError("");
          }}
        />
        {info.requireApproval && (
          <p className="muted">Staff will approve your family before you can borrow.</p>
        )}
        <Button type="submit" className="btn--block" busy={busy} busyLabel="Joining…">
          Join the library
        </Button>
      </form>
      <p className="muted">
        Is someone in your household already a member? Ask them to use "Add another adult" on their
        Account page instead, so you share one list of books.
      </p>
      <p className="muted">Signed in as {me.user.email}.</p>
    </Layout>
  );
}

/** Opened from an invitation email. */
export function InvitePage({ token }: { token: string }) {
  const { state, refresh } = useSession();
  const me = state.status === "ready" ? state.me : null;
  const [info, setInfo] = useState<{
    library: { name: string; slug: string };
    email: string;
    familyName: string | null;
    role: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [firstNameError, setFirstNameError] = useState("");
  const needsName = Boolean(me?.user && !me.user.name.trim());
  const inviteNameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<NonNullable<typeof info>>(`/invites/${encodeURIComponent(token)}`)
      .then((res) => {
        setInfo(res);
        rememberToken("invite", token);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [token]);

  const accept = async (event?: FormEvent) => {
    event?.preventDefault();
    if (needsName && !firstName.trim()) {
      setFirstNameError("Type your first name.");
      inviteNameInput.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/invites/accept", {
        body: { token, firstName: needsName ? firstName : undefined },
      });
      forgetTokens();
      await refresh();
      const home = info?.library.slug ? `/${info.library.slug}` : "";
      navigate(info?.role === "member" ? `${home}/?joined=1` : `${home}/admin`, {
        replace: true,
        absolute: true,
      });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  if (!info) {
    return (
      <Layout title={error ? "This invitation can't be used" : "Opening your invitation…"}>
        {error ? <Alert>{error}</Alert> : <Loading />}
      </Layout>
    );
  }

  const what =
    info.role === "member"
      ? `borrow books${info.familyName ? ` as the ${info.familyName} family` : ""}`
      : `help run the library as ${info.role === "admin" ? "an admin" : "staff"}`;
  const signedInAsSomeoneElse =
    me?.user && me.user.email.toLowerCase() !== info.email.toLowerCase();

  return (
    <Layout title={`Join ${info.library.name}`}>
      <p className="lead">You're invited to {what}.</p>
      <Alert>{error}</Alert>
      {!me?.user ? (
        <>
          <p>
            Sign in with <strong>{info.email}</strong>. We'll email you a 6-digit code.
          </p>
          <Button
            className="btn--block"
            onClick={() =>
              navigate(
                `/signin?email=${encodeURIComponent(info.email)}&next=${encodeURIComponent(`/invite/${token}`)}`,
              )
            }
          >
            Continue
          </Button>
        </>
      ) : signedInAsSomeoneElse ? (
        <>
          <Alert kind="info">
            This invitation is for {info.email}, but you're signed in as {me.user.email}.
          </Alert>
          <Button
            variant="secondary"
            busy={busy}
            busyLabel="Signing out…"
            onClick={async () => {
              setBusy(true);
              await authClient.signOut();
              await refresh();
              setBusy(false);
            }}
          >
            Sign out, then continue as {info.email}
          </Button>
        </>
      ) : (
        <form onSubmit={accept} noValidate className="stack">
          {needsName && (
            <Field
              ref={inviteNameInput}
              label="Your first name"
              hint="So the library knows who's who."
              autoComplete="given-name"
              maxLength={40}
              error={firstNameError}
              value={firstName}
              onChange={(e) => {
                setFirstName(e.target.value);
                setFirstNameError("");
              }}
            />
          )}
          <Button type="submit" className="btn--block" busy={busy} busyLabel="Joining…">
            Accept the invitation
          </Button>
        </form>
      )}
    </Layout>
  );
}
