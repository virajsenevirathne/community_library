import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../components.tsx";

/** The library's sign-up QR code as SVG markup, made here from the link. */
export function useJoinQr(url: string | null): string {
  const [qr, setQr] = useState("");
  useEffect(() => {
    if (!url) return setQr("");
    void QRCode.toString(url, { type: "svg", margin: 2, errorCorrectionLevel: "M" }).then(setQr);
  }, [url]);
  return qr;
}

/** A file name from the library's name: "Little Owls" → "little-owls-sign-up-qr.png". */
function fileName(libraryName: string) {
  const slug = libraryName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "library"}-sign-up-qr.png`;
}

/** How long the poster stays ready after printing: phones may say "done" early. */
const AFTER_PRINT_MS = 2000;
/** If the browser never says printing is done, tidy up anyway. */
const PRINT_GIVE_UP_MS = 120_000;

/**
 * Share the sign-up link (the phone's own share sheet, or copy it where there
 * isn't one), download its QR code as a picture, and print a poster.
 * `onError("")` clears an earlier error when another action starts.
 */
export function JoinShareButtons({
  url,
  libraryName,
  onError,
  withCopy = false,
}: {
  url: string;
  libraryName: string;
  onError: (message: string) => void;
  /** A separate Copy link button, for pages where people come to copy it. */
  withCopy?: boolean;
}) {
  const [status, setStatus] = useState("");
  const [printing, setPrinting] = useState(false);
  const statusTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const qr = useJoinQr(url);

  const say = useCallback((message: string) => {
    clearTimeout(statusTimer.current);
    setStatus(message);
    statusTimer.current = setTimeout(() => setStatus(""), 3000);
  }, []);
  useEffect(() => () => clearTimeout(statusTimer.current), []);

  // While the poster is up, printing shows only it. It's kept until printing is
  // well over, so a phone that says "done" too soon still prints it.
  useEffect(() => {
    if (!printing) return;
    document.body.classList.add("print-poster");
    let later: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(later);
      later = setTimeout(() => setPrinting(false), AFTER_PRINT_MS);
    };
    window.addEventListener("afterprint", done);
    const giveUp = setTimeout(() => setPrinting(false), PRINT_GIVE_UP_MS);
    // Let the poster render before the print preview is made.
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(later);
      clearTimeout(giveUp);
      window.removeEventListener("afterprint", done);
      document.body.classList.remove("print-poster");
    };
  }, [printing]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      say("Link copied");
    } catch {
      onError("Couldn't copy. Select the link and copy it instead.");
    }
  };

  const share = async () => {
    onError("");
    const data = {
      title: `Join ${libraryName}`,
      text: `Borrow books from ${libraryName}: sign up here.`,
      url,
    };
    if (navigator.share && navigator.canShare?.(data) !== false) {
      try {
        await navigator.share(data);
        return;
      } catch (e) {
        // Closing the share sheet isn't a problem; anything else falls back to copying.
        if (e instanceof Error && e.name === "AbortError") return;
      }
    }
    await copy();
  };

  const download = async () => {
    onError("");
    try {
      // A file (not a data: address), so iPhones save it rather than open it.
      const canvas = document.createElement("canvas");
      await QRCode.toCanvas(canvas, url, { width: 1024, margin: 2, errorCorrectionLevel: "M" });
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("no picture");
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = fileName(libraryName);
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      say("QR code downloaded");
    } catch {
      onError("Couldn't make the picture. Try printing the poster instead.");
    }
  };

  return (
    <>
      <div className="row">
        <Button onClick={() => void share()}>Share the link</Button>
        {withCopy && (
          <Button variant="secondary" onClick={() => void copy()}>
            Copy link
          </Button>
        )}
        <Button variant="secondary" onClick={() => void download()}>
          Download QR code
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            onError("");
            // Already up (the browser never said printing was done): print again.
            if (printing) window.print();
            else setPrinting(true);
          }}
        >
          Print a poster
        </Button>
      </div>
      <p className="muted" role="status">
        {status ? `${status}.` : ""}
      </p>
      {printing &&
        qr &&
        createPortal(
          <div className="poster-print">
            <p className="poster-print__name">{libraryName}</p>
            <p className="poster-print__sub">
              Borrow our books! Point your phone camera at this code to join.
            </p>
            <div
              className="poster-print__qr"
              // Generated locally by the qrcode library from our own link.
              // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, locally generated SVG
              dangerouslySetInnerHTML={{ __html: qr }}
            />
            <p className="poster-print__url">{url}</p>
          </div>,
          document.body,
        )}
    </>
  );
}
