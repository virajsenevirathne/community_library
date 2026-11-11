import { type FormEvent, useEffect, useState } from "react";
import { Alert, Button, Field, Layout, Loading } from "../components.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { authClient, forgetTokens, rememberToken } from "../lib/auth.ts";
import { Link, navigate } from "../lib/router.tsx";
import { useSession } from "../lib/session.tsx";

/** Opened from the library's sign-up link or QR code. */
export function JoinPage({ token }: { token: string }) {
  const { state, refresh } = useSession();
  const me = state.status === "ready" ? state.me : null;
  const [info, setInfo] = useState<{ library: { name: string }; requireApproval: boolean } | null>(
    null,
  );
  const [error, setError] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ library: { name: string }; requireApproval: boolean }>(
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
    if (!familyName.trim()) {
      setFieldError("Type your family name, for example your surname.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/join", { body: { token, familyName } });
      forgetTokens();
      await refresh();
      navigate("/?joined=1", { replace: true });
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
            This sign-up link is no longer active. Please ask staff at the centre for the current
            link or QR code.
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
          6-digit code: no password needed. Then you'll type your family name.
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
        <strong>Step 2 of 2:</strong> your family name.
      </p>
      <form onSubmit={join} noValidate>
        <Field
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
        Signed in as {me.user.email}. Is your partner already a member? Ask staff to add you to your
        family instead, so you share one list of books.
      </p>
    </Layout>
  );
}

/** Opened from an invitation email. */
export function InvitePage({ token }: { token: string }) {
  const { state, refresh } = useSession();
  const me = state.status === "ready" ? state.me : null;
  const [info, setInfo] = useState<{
    library: { name: string };
    email: string;
    familyName: string | null;
    role: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<NonNullable<typeof info>>(`/invites/${encodeURIComponent(token)}`)
      .then((res) => {
        setInfo(res);
        rememberToken("invite", token);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [token]);

  const accept = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/invites/accept", { body: { token } });
      forgetTokens();
      await refresh();
      navigate(info?.role === "member" ? "/?joined=1" : "/admin", { replace: true });
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
        <Button className="btn--block" onClick={accept} busy={busy} busyLabel="Joining…">
          Accept the invitation
        </Button>
      )}
    </Layout>
  );
}
