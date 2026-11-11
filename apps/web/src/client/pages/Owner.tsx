import { slugify } from "@community-library/core";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Field, Layout, Loading } from "../components.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { Link } from "../lib/router.tsx";
import { browserTimezone, timezoneList } from "./Setup.tsx";

interface OwnedLibrary {
  id: string;
  name: string;
  slug: string;
  status: "active" | "paused";
  setUp: boolean;
  families: number;
  titles: number;
  loansOut: number;
  admins: number;
  pendingAdmin: string | null;
  lastActivity: number | null;
}

type Notice = { kind: "success" | "error"; text: string } | null;

const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The site owner's page: every library, and a form to start a new one. */
export function OwnerPage() {
  const [libraries, setLibraries] = useState<OwnedLibrary[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    try {
      setLibraries((await api<{ libraries: OwnedLibrary[] }>("/owner/libraries")).libraries);
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const noticeRef = useRef<HTMLDivElement>(null);
  const done = async (message: Notice) => {
    setNotice(message);
    await load();
    // The form or card that asked may be far down the page, on a phone especially.
    requestAnimationFrame(() => {
      noticeRef.current?.scrollIntoView({ block: "nearest" });
      noticeRef.current?.focus({ preventScroll: true });
    });
  };

  return (
    <Layout title="Your libraries" siteWide width="wide">
      <p className="lead">
        Create a library for each group and invite its admin. They set it up and run it from there.
      </p>
      <Alert>{error}</Alert>
      <div ref={noticeRef} tabIndex={-1}>
        {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      </div>
      <div className="split split--aside-first">
        <div>
          {libraries === null ? (
            !error && <Loading label="Loading libraries…" />
          ) : libraries.length === 0 ? (
            <div className="empty">
              <p className="empty__title">No libraries yet</p>
              <p>Create the first one with the form on this page.</p>
            </div>
          ) : (
            <ul className="owner-list">
              {libraries.map((library) => (
                <LibraryCard key={library.id} library={library} onDone={done} />
              ))}
            </ul>
          )}
        </div>
        <aside>
          <CreateLibrary onDone={done} />
        </aside>
      </div>
    </Layout>
  );
}

function CreateLibrary({ onDone }: { onDone: (notice: Notice) => Promise<void> }) {
  const deviceZone = useMemo(browserTimezone, []);
  const zones = useMemo(() => timezoneList(deviceZone), [deviceZone]);
  const empty = { name: "", slug: "", timezone: deviceZone, adminEmail: "" };
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState<Partial<Record<"name" | "adminEmail", string>>>({});
  const [busy, setBusy] = useState(false);
  const address = form.slug.trim() || (form.name.trim() ? slugify(form.name) : "");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: typeof errors = {};
    if (!form.name.trim()) found.name = "Give the library a name.";
    if (!form.adminEmail.trim()) found.adminEmail = "Enter the email of the person who'll run it.";
    setErrors(found);
    if (found.name || found.adminEmail) return;
    setBusy(true);
    try {
      const res = await api<{ library: { name: string }; inviteSent: boolean }>(
        "/owner/libraries",
        {
          body: {
            name: form.name,
            slug: form.slug.trim() || undefined,
            timezone: form.timezone,
            adminEmail: form.adminEmail,
          },
        },
      );
      setForm(empty);
      await onDone({
        kind: res.inviteSent ? "success" : "error",
        text: res.inviteSent
          ? `Created ${res.library.name}. We've emailed ${form.adminEmail.trim()} the steps to set it up.`
          : `Created ${res.library.name}, but the invite email couldn't be sent. Use "Invite an admin" to try again.`,
      });
    } catch (e) {
      await onDone({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="create-heading">
      <h2 id="create-heading" className="section-title">
        Create a library
      </h2>
      <form onSubmit={submit} noValidate className="stack">
        <Field
          label="Library name"
          hint="As families will see it, for example “Little Owls Book Corner”."
          maxLength={80}
          autoComplete="off"
          error={errors.name}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <Field
          label="Address (optional)"
          hint={
            address
              ? `The library will be at /${address}. It can't be changed later.`
              : "Made from the name if left empty. It can't be changed later."
          }
          maxLength={40}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={form.slug}
          onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
        />
        <div className="field">
          <label htmlFor="owner-timezone">Timezone</label>
          <select
            id="owner-timezone"
            value={form.timezone}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Email of its first admin"
          hint="They'll get an invite with the steps to set the library up."
          type="email"
          autoComplete="off"
          error={errors.adminEmail}
          value={form.adminEmail}
          onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
        />
        <Button type="submit" busy={busy} busyLabel="Creating…">
          Create and send the invite
        </Button>
      </form>
    </section>
  );
}

function LibraryCard({
  library,
  onDone,
}: {
  library: OwnedLibrary;
  onDone: (notice: Notice) => Promise<void>;
}) {
  const [panel, setPanel] = useState<"none" | "rename" | "invite" | "pause">("none");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (request: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await request();
      setPanel("none");
      setValue("");
      await onDone({ kind: "success", text: success });
    } catch (e) {
      await onDone({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const open = (next: typeof panel, initial = "") => {
    setPanel(panel === next ? "none" : next);
    setValue(initial);
  };

  const status =
    library.status === "paused"
      ? { label: "Paused", className: "badge--lost" }
      : library.setUp
        ? { label: "Running", className: "badge--available" }
        : { label: "Waiting for setup", className: "badge--warn" };

  return (
    <li className="card owner-card">
      <div className="owner-card__head">
        <div>
          <h2 className="owner-card__name">{library.name}</h2>
          <p className="muted code">/{library.slug}</p>
        </div>
        <span className={`badge ${status.className}`}>{status.label}</span>
      </div>
      <p className="owner-card__stats">
        {plural(library.families, "family", "families")} · {plural(library.titles, "book", "books")}{" "}
        · {library.loansOut} out
        {library.lastActivity ? ` · last active ${DAY.format(new Date(library.lastActivity))}` : ""}
      </p>
      <p className="muted">
        {library.admins > 0
          ? plural(library.admins, "admin", "admins")
          : library.pendingAdmin
            ? `Invite sent to ${library.pendingAdmin}, not accepted yet`
            : "No admin yet"}
      </p>
      <div className="row row--tight">
        <Link href={`/${library.slug}/`} absolute className="btn btn--secondary">
          Open
        </Link>
        <Button
          variant={library.admins === 0 && !library.pendingAdmin ? "primary" : "secondary"}
          onClick={() => open("invite")}
          aria-expanded={panel === "invite"}
        >
          Invite an admin
        </Button>
        <Button
          variant="secondary"
          onClick={() => open("rename", library.name)}
          aria-expanded={panel === "rename"}
        >
          Rename
        </Button>
        {library.status === "paused" ? (
          <Button
            variant="secondary"
            busy={busy}
            busyLabel="Reopening…"
            onClick={() =>
              run(
                () =>
                  api(`/owner/libraries/${library.id}`, {
                    method: "PATCH",
                    body: { status: "active" },
                  }),
                `${library.name} is open again.`,
              )
            }
          >
            Reopen
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => open("pause")}
            aria-expanded={panel === "pause"}
          >
            Pause
          </Button>
        )}
      </div>

      {panel === "invite" && (
        <form
          className="owner-panel"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () => api(`/owner/libraries/${library.id}/admin-invite`, { body: { email: value } }),
              `Invite sent to ${value.trim()}.`,
            );
          }}
        >
          <Field
            label="Their email"
            type="email"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" busy={busy} busyLabel="Sending…">
            Send the invite
          </Button>
        </form>
      )}
      {panel === "rename" && (
        <form
          className="owner-panel"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () =>
                api(`/owner/libraries/${library.id}`, { method: "PATCH", body: { name: value } }),
              `Renamed to ${value.trim()}. Its address stays /${library.slug}.`,
            );
          }}
        >
          <Field
            label="New name"
            maxLength={80}
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" busy={busy} busyLabel="Saving…">
            Save the name
          </Button>
        </form>
      )}
      {panel === "pause" && (
        <div className="owner-panel">
          <p>
            Pause {library.name}? Families and staff can still look, but nothing can be borrowed or
            changed, and reminder emails stop until you reopen it.
          </p>
          <div className="row row--tight">
            <Button variant="secondary" onClick={() => setPanel("none")}>
              Cancel
            </Button>
            <Button
              variant="danger"
              busy={busy}
              busyLabel="Pausing…"
              onClick={() =>
                run(
                  () =>
                    api(`/owner/libraries/${library.id}`, {
                      method: "PATCH",
                      body: { status: "paused" },
                    }),
                  `${library.name} is paused.`,
                )
              }
            >
              Yes, pause it
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
