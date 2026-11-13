import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { JoinShareButtons, useJoinQr } from "../../components/JoinShare.tsx";
import { Alert, Button, Field, Layout, Loading } from "../../components.tsx";
import { ApiError, api, errorMessage } from "../../lib/api.ts";
import { Link } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";
import { FamilyKiosk, type KioskPerson, NoEmailFamilyCard } from "./FamilyKiosk.tsx";

interface Invite {
  id: string;
  email: string;
  role: string;
  state: "queued" | "sent" | "expired";
}

interface Family {
  id: string;
  name: string;
  status: "active" | "pending" | "deactivated";
  booksOut: number;
  adults: Adult[];
  invites: Invite[];
  kioskPeople: KioskPerson[];
}

interface Adult {
  userId: string;
  name: string;
  email: string;
}

/** "Priya" when a first name is known, otherwise the email address. */
function adultName(adult: { name: string; email: string }) {
  return adult.name.trim() || adult.email;
}

/** Adults without email: they borrow at the kiosk with a code. */
function noEmailAdults(family: Family) {
  return family.kioskPeople.filter((k) => k.userId === null);
}

/** "Lee (Priya, Tom)": tells apart two families with the same name. */
function familyLabel(family: Family) {
  const names = [...family.adults.map(adultName), ...noEmailAdults(family).map((k) => k.name)].join(
    ", ",
  );
  return names ? `${family.name} (${names})` : family.name;
}

interface FamiliesData {
  families: Family[];
  staff: StaffPerson[];
  staffInvites: Invite[];
  joinUrl: string | null;
  canManageStaff: boolean;
  /** The library has a kiosk tablet turned on. */
  kioskInUse: boolean;
}

interface StaffPerson {
  userId: string;
  name: string;
  email: string;
  role: string;
}

const STATUS: Record<Family["status"], string> = {
  active: "Active",
  pending: "Waiting for approval",
  deactivated: "Paused",
};

const INVITE_STATE: Record<Invite["state"], string> = {
  queued: "invitation waiting to send",
  sent: "invited",
  expired: "invitation expired",
};

const ROLE_NAMES: Record<string, string> = { admin: "Admin", staff: "Staff", member: "Parent" };

type Notify = {
  success: (message: string) => Promise<void>;
  error: (message: string) => void;
  /** Reloads the list without a message. */
  reload: () => Promise<void>;
};

export function FamiliesPage() {
  const [data, setData] = useState<FamiliesData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [onlyWaiting, setOnlyWaiting] = useState(false);
  const messageRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<FamiliesData>("/admin/families"));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // Opened from the dashboard's "create one" link: go straight to the sign-up card.
  const loaded = data !== null;
  useEffect(() => {
    if (loaded && window.location.hash === "#join-card") {
      document.getElementById("join-card")?.scrollIntoView({ block: "start" });
    }
  }, [loaded]);

  // Every action reports here; the message gets focus so it is read out.
  const notify: Notify = {
    success: async (message) => {
      setNotice(message);
      setError("");
      await load();
      messageRef.current?.focus();
    },
    error: (message) => {
      setError(message);
      setNotice("");
      messageRef.current?.focus();
    },
    reload: async () => {
      setError("");
      setNotice("");
      await load();
    },
  };

  if (!data) {
    return (
      <Layout title="Families" back="/admin">
        {error ? <Alert>{error}</Alert> : <Loading />}
      </Layout>
    );
  }

  const q = query.trim().toLowerCase();
  const pending = data.families.filter((f) => f.status === "pending").length;
  const shown = data.families.filter(
    (f) =>
      (!onlyWaiting || f.status === "pending") &&
      (!q ||
        f.name.toLowerCase().includes(q) ||
        f.adults.some(
          (a) => a.email.toLowerCase().includes(q) || a.name.toLowerCase().includes(q),
        ) ||
        f.kioskPeople.some((k) => k.name.toLowerCase().includes(q))),
  );
  // Families sharing a name are often one household that joined twice.
  const sameName = (family: Family) =>
    data.families.filter(
      (f) => f.id !== family.id && f.name.trim().toLowerCase() === family.name.trim().toLowerCase(),
    );

  return (
    <Layout
      title="Families"
      back="/admin"
      width="wide"
      actions={
        <Link href="/admin/families/import" className="btn btn--secondary">
          Import from a spreadsheet
        </Link>
      }
    >
      <div ref={messageRef} tabIndex={-1}>
        <Alert>{error}</Alert>
        <Alert kind="success">{notice}</Alert>
      </div>

      <div className="split split--aside-first">
        <div>
          <h2 className="section-title">
            {data.families.length} {data.families.length === 1 ? "family" : "families"}
            {pending > 0 && (
              <span className="badge badge--found">
                <span className="visually-hidden">, </span>
                {pending} waiting
              </span>
            )}
          </h2>
          {pending > 0 && (
            <label className="check">
              <input
                type="checkbox"
                checked={onlyWaiting}
                onChange={(e) => setOnlyWaiting(e.target.checked)}
              />
              Show only families waiting for approval
            </label>
          )}
          {data.families.length > 5 && (
            <Field
              label="Find a family"
              type="search"
              hint="Family name, or an adult's first name or email"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {shown.length === 0 && (
            <div className="empty">
              <p className="empty__title">
                {q || onlyWaiting ? "No families match" : "No families yet"}
              </p>
              <p>
                {q || onlyWaiting
                  ? "Try a different name or email."
                  : "Print or share the sign-up link so parents can join."}
              </p>
            </div>
          )}
          <ul className="loan-list">
            {shown.map((family) => (
              <FamilyCard
                key={family.id}
                family={family}
                twins={sameName(family)}
                others={data.families.filter((f) => f.id !== family.id)}
                kioskInUse={data.kioskInUse}
                notify={notify}
              />
            ))}
          </ul>

          {data.canManageStaff && (
            <StaffSection staff={data.staff} invites={data.staffInvites} notify={notify} />
          )}
        </div>
        <aside>
          <JoinLinkCard url={data.joinUrl} canChange={data.canManageStaff} notify={notify} />
          {data.kioskInUse && <NoEmailFamilyCard notify={notify} />}
        </aside>
      </div>
    </Layout>
  );
}

function JoinLinkCard({
  url,
  canChange,
  notify,
}: {
  url: string | null;
  canChange: boolean;
  notify: Notify;
}) {
  const { state } = useSession();
  const libraryName =
    state.status === "ready" ? (state.me.library?.name ?? "the library") : "the library";
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"replace" | "off" | null>(null);

  const qr = useJoinQr(url);

  const change = async (enabled: boolean) => {
    setBusy(true);
    try {
      await api("/admin/join-link", { body: { enabled } });
      setConfirming(null);
      await notify.success(
        enabled
          ? url
            ? "New sign-up link ready. Reprint any posters: the old QR code no longer works."
            : "Sign-up link ready."
          : "The sign-up link is turned off.",
      );
    } catch (e) {
      notify.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" id="join-card" aria-labelledby="join-heading">
      <h2 id="join-heading" className="section-title">
        Sign-up link
      </h2>
      {url ? (
        <>
          <p>
            Share this link (in your newsletter, group chat or email), or print the QR code as a
            poster by the shelf. Parents open it, sign in with their email, and type their family
            name.
          </p>
          <div className="join-link">
            {qr && (
              <div
                className="join-link__qr"
                role="img"
                aria-label="QR code for the sign-up link"
                // Generated locally by the qrcode library from our own link.
                // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, locally generated SVG
                dangerouslySetInnerHTML={{ __html: qr }}
              />
            )}
            <div className="stack">
              <input
                className="join-link__url"
                readOnly
                value={url}
                aria-label="Sign-up link"
                onFocus={(e) => e.target.select()}
              />
              <JoinShareButtons
                url={url}
                libraryName={libraryName}
                withCopy
                onError={(message) => {
                  if (message) notify.error(message);
                }}
              />
            </div>
          </div>
          {canChange &&
            (confirming ? (
              <div className="confirm" style={{ marginTop: "0.75rem" }}>
                <p className="confirm__text">
                  {confirming === "replace"
                    ? "Make a new link? The current link and QR code will stop working straight away, so reprint any posters."
                    : "Turn off the sign-up link? New families can then only join by invitation."}
                </p>
                <div className="row">
                  <Button variant="secondary" onClick={() => setConfirming(null)} autoFocus>
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => change(confirming === "replace")}
                    busy={busy}
                    busyLabel="Saving…"
                  >
                    {confirming === "replace" ? "Make a new link" : "Turn the link off"}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="row" style={{ marginTop: "0.75rem" }}>
                  <Button variant="link" onClick={() => setConfirming("replace")}>
                    Make a new link
                  </Button>
                  <Button variant="link" onClick={() => setConfirming("off")}>
                    Turn the link off
                  </Button>
                </div>
                <p className="muted">
                  Make a new link if the old one was shared more widely than you'd like.
                </p>
              </>
            ))}
        </>
      ) : canChange ? (
        <>
          <p>
            A sign-up link lets families join themselves: anyone with the link can sign up. To check
            each new family first, turn on approval in Settings.
          </p>
          <Button onClick={() => change(true)} busy={busy} busyLabel="Creating…">
            Create a sign-up link
          </Button>
        </>
      ) : (
        <p>The sign-up link is turned off. The library admin can turn it on.</p>
      )}
    </section>
  );
}

function InviteRow({ invite, notify }: { invite: Invite; notify: Notify }) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, request: () => Promise<unknown>, message: string) => {
    setBusy(key);
    try {
      await request();
      await notify.success(message);
    } catch (e) {
      notify.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="invite-row muted">
      <span>
        {invite.email} · {ROLE_NAMES[invite.role] ?? invite.role} · {INVITE_STATE[invite.state]}
      </span>
      <span className="row">
        <Button
          variant="link"
          onClick={() =>
            run(
              "resend",
              () => api(`/admin/invites/${invite.id}/resend`, { body: {} }),
              `Invitation sent again to ${invite.email}.`,
            )
          }
          busy={busy === "resend"}
        >
          {/* The visible words first, so voice control ("click Send again") finds it. */}
          Send again<span className="visually-hidden"> to {invite.email}</span>
        </Button>
        <Button
          variant="link"
          onClick={() =>
            run(
              "cancel",
              () => api(`/admin/invites/${invite.id}`, { method: "DELETE" }),
              `Invitation to ${invite.email} cancelled.`,
            )
          }
          busy={busy === "cancel"}
        >
          Cancel invitation<span className="visually-hidden"> to {invite.email}</span>
        </Button>
      </span>
    </li>
  );
}

function FamilyCard({
  family,
  twins,
  others,
  kioskInUse,
  notify,
}: {
  family: Family;
  /** Other families with the same name: possibly the same household. */
  twins: Family[];
  others: Family[];
  kioskInUse: boolean;
  notify: Notify;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  /** The family chosen to merge this one into, waiting for confirmation. */
  const [merging, setMerging] = useState<string | null>(null);
  const [mergeChoice, setMergeChoice] = useState("");
  const [moveWho, setMoveWho] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const mergeTarget = others.find((f) => f.id === merging) ?? null;
  // "ask": confirm removal. Any other text: removal was refused because books are out.
  const [removing, setRemoving] = useState<string | null>(null);
  const confirmRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (removing || merging) confirmRef.current?.focus();
  }, [removing, merging]);
  // A confirmation hands focus back to the button that opened it when cancelled.
  const opener = useRef<HTMLElement | null>(null);
  const openConfirm = (open: () => void) => {
    opener.current = document.activeElement as HTMLElement | null;
    open();
  };
  const closeConfirm = (close: () => void) => {
    close();
    requestAnimationFrame(() => opener.current?.focus());
  };
  // Choices that no longer match a row (after a move or merge) count as unchosen.
  const moveAdult = family.adults.find((a) => a.userId === moveWho) ?? null;
  const moveFamily = others.find((f) => f.id === moveTo) ?? null;
  const mergeFamily = others.find((f) => f.id === mergeChoice) ?? null;

  const call = async (key: string, request: () => Promise<unknown>, message: string) => {
    setBusy(key);
    try {
      await request();
      await notify.success(message);
      return true;
    } catch (e) {
      notify.error(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("invite");
    setEmailError("");
    try {
      const res = await api<{ sent: boolean }>(`/admin/families/${family.id}/invite`, {
        body: { email },
      });
      setInviting(false);
      setEmail("");
      await notify.success(
        res.sent
          ? `Invitation sent to ${email}.`
          : `Invitation for ${email} saved; it will be emailed shortly.`,
      );
    } catch (e) {
      setEmailError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (markLost: boolean) => {
    setBusy("remove");
    try {
      await api(`/admin/families/${family.id}/remove`, { body: { markLost } });
      await notify.success(`The ${family.name} family has been removed.`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "books_out") setRemoving(e.message);
      else notify.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const statusClass =
    family.status === "active" ? "available" : family.status === "pending" ? "found" : "lost";
  const kioskOnly = family.adults.length === 0 && family.kioskPeople.length > 0;

  return (
    <li className="card">
      <p className="meta-row">
        <strong>{family.name}</strong>
        <span className={`badge badge--${statusClass}`}>{STATUS[family.status]}</span>
        {kioskOnly && <span className="badge">Kiosk only</span>}
        <span className="muted">
          {family.booksOut} {family.booksOut === 1 ? "book" : "books"} out
        </span>
      </p>
      <ul className="plain">
        {family.adults.map((a) => (
          <li key={a.userId}>
            {a.name.trim() ? (
              <>
                {a.name} <span className="muted">· {a.email}</span>
              </>
            ) : (
              a.email
            )}
          </li>
        ))}
        {noEmailAdults(family).map((k) => (
          <li key={k.id}>
            {k.name} <span className="muted">· no email, borrows at the kiosk</span>
          </li>
        ))}
        {family.invites.map((i) => (
          <InviteRow key={i.id} invite={i} notify={notify} />
        ))}
      </ul>
      {kioskOnly && (
        <p className="muted">No email, so no reminders: follow up late books from Loans.</p>
      )}
      {twins.length > 0 && (
        <Alert kind="warning" live={false}>
          <p>
            {twins.length === 1 ? "Another family is" : `${twins.length} other families are`} also
            called {family.name}. If you're one household, merge them so you share one list of
            books.
          </p>
          <div className="row">
            {twins.map((twin) => (
              <Button
                key={twin.id}
                variant="secondary"
                onClick={() => openConfirm(() => setMerging(twin.id))}
                aria-label={`Merge into ${familyLabel(twin)}: moves ${familyLabel(family)} into it`}
              >
                Merge into {familyLabel(twin)}
              </Button>
            ))}
          </div>
        </Alert>
      )}
      <div className="row">
        {family.status === "pending" && (
          <Button
            onClick={() =>
              call(
                "approve",
                () => api(`/admin/families/${family.id}/status`, { body: { status: "active" } }),
                `The ${family.name} family can now borrow. We've emailed them.`,
              )
            }
            busy={busy === "approve"}
            busyLabel="Approving…"
            aria-label={`Approve the ${family.name} family`}
          >
            Approve
          </Button>
        )}
        {family.status === "deactivated" && (
          <Button
            variant="secondary"
            onClick={() =>
              call(
                "activate",
                () => api(`/admin/families/${family.id}/status`, { body: { status: "active" } }),
                `The ${family.name} family can borrow again.`,
              )
            }
            busy={busy === "activate"}
          >
            Turn borrowing back on
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={() => {
            setInviting(!inviting);
            setEmail("");
            setEmailError("");
          }}
          aria-expanded={inviting}
          aria-controls={`invite-${family.id}`}
        >
          Add another adult
        </Button>
      </div>
      {inviting && (
        <form id={`invite-${family.id}`} onSubmit={invite} noValidate className="inline-form">
          <Field
            label={`Email of another parent in the ${family.name} family`}
            type="email"
            autoComplete="off"
            autoFocus
            error={emailError}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" busy={busy === "invite"} busyLabel="Sending…">
            Send invitation
          </Button>
        </form>
      )}
      {mergeTarget && (
        <div className="confirm">
          <p className="confirm__text" ref={confirmRef} tabIndex={-1}>
            Merge {familyLabel(family)} into {familyLabel(mergeTarget)}? The adults and books move
            into one family called {mergeTarget.name}.{" "}
            {mergeTarget.status === "pending"
              ? "That family is still waiting for approval, so nobody in it can borrow until you approve it."
              : mergeTarget.status === "deactivated"
                ? "Borrowing is paused for that family, so nobody in it can borrow until you turn it back on."
                : ""}{" "}
            This can't be undone.
          </p>
          <div className="row">
            <Button variant="secondary" onClick={() => closeConfirm(() => setMerging(null))}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                const ok = await call(
                  "merge",
                  () =>
                    api(`/admin/families/${family.id}/merge`, { body: { into: mergeTarget.id } }),
                  `Merged into the ${mergeTarget.name} family.`,
                );
                if (ok) {
                  setMerging(null);
                  setMergeChoice("");
                }
              }}
              busy={busy === "merge"}
              busyLabel="Merging…"
            >
              Merge the families
            </Button>
          </div>
        </div>
      )}
      <details className="more" open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
        <summary>More</summary>
        {removing ? (
          <div className="confirm">
            <p className="confirm__text" ref={confirmRef} tabIndex={-1}>
              {removing === "ask"
                ? `Remove the ${family.name} family? Their parents lose access to the library and their sign-in is deleted. Past loans are kept as counts without their name. This can't be undone.`
                : `${removing} Remove the family anyway and mark those books lost?`}
            </p>
            <div className="row">
              <Button variant="secondary" onClick={() => closeConfirm(() => setRemoving(null))}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => remove(removing !== "ask")}
                busy={busy === "remove"}
                busyLabel="Removing…"
              >
                {removing === "ask" ? `Remove the ${family.name} family` : "Remove and mark lost"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="stack">
            {(kioskInUse || family.kioskPeople.length > 0) && (
              <FamilyKiosk family={family} notify={notify} />
            )}
            {others.length > 0 && (
              <div className="inline-form">
                <div className="field">
                  <label htmlFor={`merge-${family.id}`}>Same household as another family?</label>
                  <select
                    id={`merge-${family.id}`}
                    value={mergeFamily ? mergeChoice : ""}
                    onChange={(e) => setMergeChoice(e.target.value)}
                  >
                    <option value="">Choose a family…</option>
                    {others.map((f) => (
                      <option key={f.id} value={f.id}>
                        {familyLabel(f)}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  variant="secondary"
                  disabled={!mergeFamily}
                  onClick={() => mergeFamily && openConfirm(() => setMerging(mergeFamily.id))}
                >
                  Merge families
                </Button>
              </div>
            )}
            {family.adults.length > 1 && others.length > 0 && (
              <div className="inline-form">
                <div className="field">
                  <label htmlFor={`move-who-${family.id}`}>Move an adult</label>
                  <select
                    id={`move-who-${family.id}`}
                    value={moveAdult ? moveWho : ""}
                    onChange={(e) => setMoveWho(e.target.value)}
                  >
                    <option value="">Who…</option>
                    {family.adults.map((a) => (
                      <option key={a.userId} value={a.userId}>
                        {adultName(a)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`move-to-${family.id}`}>To family</label>
                  <select
                    id={`move-to-${family.id}`}
                    value={moveFamily ? moveTo : ""}
                    onChange={(e) => setMoveTo(e.target.value)}
                  >
                    <option value="">Choose a family…</option>
                    {others.map((f) => (
                      <option key={f.id} value={f.id}>
                        {familyLabel(f)}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  variant="secondary"
                  disabled={!moveAdult || !moveFamily}
                  busy={busy === "move"}
                  busyLabel="Moving…"
                  onClick={async () => {
                    if (!moveAdult || !moveFamily) return;
                    const ok = await call(
                      "move",
                      () =>
                        api(`/admin/families/${family.id}/adults/${moveAdult.userId}/move`, {
                          body: { to: moveFamily.id },
                        }),
                      `${adultName(moveAdult)} is now in the ${moveFamily.name} family.`,
                    );
                    if (ok) {
                      setMoveWho("");
                      setMoveTo("");
                    }
                  }}
                >
                  Move
                </Button>
              </div>
            )}
            <div className="row">
              {family.status === "active" && (
                <Button
                  variant="link"
                  onClick={() =>
                    call(
                      "pause",
                      () =>
                        api(`/admin/families/${family.id}/status`, {
                          body: { status: "deactivated" },
                        }),
                      `Borrowing is paused for the ${family.name} family.`,
                    )
                  }
                  busy={busy === "pause"}
                >
                  Pause borrowing
                </Button>
              )}
              <Button
                variant="link"
                onClick={() => openConfirm(() => setRemoving("ask"))}
                aria-label={`Remove family: ${family.name}`}
              >
                Remove family
              </Button>
            </div>
          </div>
        )}
      </details>
    </li>
  );
}

/** One staff member, with their role and a way to change it. */
function StaffRow({ person, notify }: { person: StaffPerson; notify: Notify }) {
  const [choice, setChoice] = useState(person.role);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (
      choice === "none" &&
      !confirm(`Take ${person.email} off the staff? They lose staff access straight away.`)
    )
      return;
    setBusy(true);
    try {
      await api(`/admin/staff/${person.userId}/role`, { body: { role: choice } });
      await notify.success(
        choice === "none"
          ? `${person.email} is no longer on the staff.`
          : `${person.email} is now ${choice === "admin" ? "an admin" : "staff"}.`,
      );
    } catch (e) {
      notify.error(errorMessage(e));
      setChoice(person.role);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="staff-row">
      <span>
        {person.name.trim() ? `${person.name} · ${person.email}` : person.email}{" "}
        <span className="muted">· {ROLE_NAMES[person.role] ?? person.role}</span>
      </span>
      <span className="row row--tight">
        <label className="inline-select">
          <span className="visually-hidden">Role for {person.email}</span>
          <select value={choice} disabled={busy} onChange={(e) => setChoice(e.target.value)}>
            <option value="admin">Admin</option>
            <option value="staff">Staff</option>
            <option value="none">Not staff</option>
          </select>
        </label>
        {choice !== person.role && (
          <Button onClick={save} busy={busy} busyLabel="Saving…">
            Save
          </Button>
        )}
      </span>
    </li>
  );
}

function StaffSection(props: { staff: StaffPerson[]; invites: Invite[]; notify: Notify }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"staff" | "admin">("staff");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/admin/staff/invite", { body: { email, role } });
      setEmail("");
      await props.notify.success(`Invitation sent to ${email}.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card staff-card" aria-labelledby="staff-heading">
      <h2 id="staff-heading" className="section-title">
        Staff
      </h2>
      <ul className="plain">
        {props.staff.map((s) => (
          <StaffRow key={s.userId} person={s} notify={props.notify} />
        ))}
        {props.invites.map((i) => (
          <InviteRow key={i.id} invite={i} notify={props.notify} />
        ))}
      </ul>
      <form onSubmit={invite} noValidate className="inline-form">
        <Field
          label="Invite someone to help run the library"
          type="email"
          autoComplete="off"
          error={error}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <div className="field">
          <label htmlFor="staff-role">Role</label>
          <select
            id="staff-role"
            value={role}
            onChange={(e) => setRole(e.target.value as "staff" | "admin")}
          >
            <option value="staff">Staff: books, loans and families</option>
            <option value="admin">Admin: also settings and staff</option>
          </select>
        </div>
        <Button type="submit" variant="secondary" busy={busy} busyLabel="Sending…">
          Send invitation
        </Button>
      </form>
    </section>
  );
}
