import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { Alert, Button } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { LogoError, type ShrunkLogo, shrinkLogo } from "../../lib/logo.ts";
import { useSession } from "../../lib/session.tsx";

type Focus = "input" | "save" | "remove" | "confirm" | null;

/**
 * Settings › Logo: the library's own picture in its header and on its kiosks,
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
  const [confirming, setConfirming] = useState(false);
  const [focus, setFocus] = useState<Focus>(null);
  const input = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const confirmText = useRef<HTMLParagraphElement>(null);

  // The control used is often replaced: move focus to what took its place.
  useEffect(() => {
    const target = {
      input,
      save: saveButton,
      remove: removeButton,
      confirm: confirmText,
    }[focus ?? "input"];
    if (focus) target.current?.focus();
    setFocus(null);
  }, [focus]);

  const clear = () => {
    setError("");
    setNotice("");
  };

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Choosing the same file again still counts as a change.
    event.target.value = "";
    if (!file || busy) return;
    clear();
    setBusy("prepare");
    try {
      const shrunk = await shrinkLogo(file);
      setChosen(shrunk);
      setNotice(
        shrunk.flattened
          ? "Picture ready. Its see-through parts are white now, to keep it small. Check it, then save."
          : "Picture ready. Check how it looks, then save.",
      );
      setFocus("save");
    } catch (e) {
      setChosen(null);
      setError(e instanceof LogoError ? e.message : "That picture couldn't be opened.");
      setFocus("input");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!chosen) return;
    setBusy("save");
    clear();
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
    clear();
    try {
      await api("/admin/logo", { method: "DELETE" });
      await refresh();
      setConfirming(false);
      setNotice("Logo removed: the joey is back. Choose a picture to add one again.");
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
      <p className="muted">
        Optional. It shows next to your library's name at the top of its pages and on its kiosks,
        only to people in your library. A square logo works best.
      </p>
      <Alert>{error}</Alert>
      <Alert kind={chosen ? "info" : "success"}>{notice}</Alert>
      {busy === "prepare" && <Alert kind="info">Preparing the picture…</Alert>}
      {shown && (
        <div className="logo-preview">
          <img
            src={shown}
            alt={chosen ? "Your new logo, not saved yet, on a light screen" : "Your library's logo"}
          />
          {/* How it looks when a phone is in dark mode. */}
          <img
            className="logo-preview__dark"
            src={shown}
            alt={chosen ? "The same, on a dark screen" : "Your library's logo, on a dark screen"}
          />
        </div>
      )}
      {chosen ? (
        <div className="row" key="chosen">
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
              clear();
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
            <p className="field__hint" id="logo-file-hint">
              PNG, JPEG, WebP or SVG. It's made small before it's saved.
            </p>
            <input
              ref={input}
              id="logo-file"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              aria-describedby="logo-file-hint"
              // Not disabled while busy: that would drop the focus. Changes wait instead.
              aria-disabled={busy !== null}
              onChange={(e) => void choose(e)}
            />
          </div>
          {current &&
            (confirming ? (
              <div className="confirm" key="confirm">
                <p className="confirm__text" ref={confirmText} tabIndex={-1}>
                  Remove the logo? The joey comes back until you add one again.
                </p>
                <div className="row">
                  <Button
                    variant="danger"
                    onClick={() => void remove()}
                    busy={busy === "remove"}
                    busyLabel="Removing…"
                  >
                    Remove it
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setConfirming(false);
                      setFocus("remove");
                    }}
                  >
                    Keep it
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                key="remove"
                ref={removeButton}
                variant="secondary"
                onClick={() => {
                  clear();
                  setConfirming(true);
                  setFocus("confirm");
                }}
              >
                Remove the logo
              </Button>
            ))}
        </>
      )}
    </section>
  );
}
