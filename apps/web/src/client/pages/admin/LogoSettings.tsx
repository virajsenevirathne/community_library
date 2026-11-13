import { type ChangeEvent, useEffect, useId, useRef, useState } from "react";
import { Alert, Button } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { LogoError, type ShrunkLogo, shrinkLogo } from "../../lib/logo.ts";
import { useSession } from "../../lib/session.tsx";

/**
 * Settings › Logo: the library's own picture in its header and on its kiosk,
 * instead of the joey. Saved straight away, apart from the settings form.
 */
export function LogoSettings() {
  const { state, refresh } = useSession();
  const library = state.status === "ready" ? state.me.library : null;
  const current = library?.logo
    ? `/api/logo/${encodeURIComponent(library.slug)}?v=${library.logo}`
    : null;
  const [chosen, setChosen] = useState<ShrunkLogo | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"save" | "remove" | "prepare" | null>(null);
  const [focus, setFocus] = useState<"input" | "save" | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const hintId = useId();

  // The control used is often replaced: move focus to what took its place.
  useEffect(() => {
    if (focus === "input") input.current?.focus();
    if (focus === "save") saveButton.current?.focus();
    if (focus) setFocus(null);
  }, [focus]);

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setError("");
    setNotice("");
    if (!file) return;
    setBusy("prepare");
    try {
      setChosen(await shrinkLogo(file));
      setFocus("save");
    } catch (e) {
      setChosen(null);
      setError(e instanceof LogoError ? e.message : "That picture couldn't be opened.");
    } finally {
      setBusy(null);
      // Choosing the same file again still counts as a change.
      event.target.value = "";
    }
  };

  const save = async () => {
    if (!chosen) return;
    setBusy("save");
    setError("");
    try {
      await api("/admin/logo", { method: "PUT", body: { image: chosen.base64 } });
      await refresh();
      setChosen(null);
      setNotice("Logo saved. It shows at the top of your library's pages and on its kiosks.");
      setFocus("input");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    setError("");
    setNotice("");
    try {
      await api("/admin/logo", { method: "DELETE" });
      await refresh();
      setNotice("Logo removed. The joey is back at the top of your pages.");
      setFocus("input");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const shown = chosen?.dataUrl ?? current;
  return (
    <section className="card stack" aria-labelledby="logo-heading">
      <h2 id="logo-heading" className="section-title">
        Logo
      </h2>
      <p className="muted" id={hintId}>
        Optional. Your library's logo shows at the top of its pages and on its kiosks, next to its
        name. Only people in your library see it. A square or wide picture works best; it's made
        small before it's saved.
      </p>
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>
      {shown && (
        <div className="logo-preview">
          <img src={shown} alt={chosen ? "Your new logo, not saved yet" : "Your library's logo"} />
        </div>
      )}
      {chosen ? (
        <div className="row">
          <Button
            ref={saveButton}
            onClick={() => void save()}
            busy={busy === "save"}
            busyLabel="Saving…"
          >
            Save this logo
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setChosen(null);
              setFocus("input");
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="logo-file">
              {current ? "Choose a different picture" : "Choose a picture"}
            </label>
            <input
              ref={input}
              id="logo-file"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              aria-describedby={hintId}
              disabled={busy !== null}
              onChange={(e) => void choose(e)}
            />
          </div>
          {busy === "prepare" && <p className="muted">Preparing the picture…</p>}
          {current && (
            <Button
              variant="secondary"
              onClick={() => void remove()}
              busy={busy === "remove"}
              busyLabel="Removing…"
            >
              Remove the logo
            </Button>
          )}
        </>
      )}
    </section>
  );
}
