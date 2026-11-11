import { useEffect, useRef, useState } from "react";

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };

/**
 * Uses the browser's own barcode reader where there is one (Chrome on
 * Android), and otherwise loads a small WebAssembly reader from this site
 * (iPhone Safari and others). Loaded only when the scanner opens.
 */
async function createDetector(formats: string[]): Promise<Detector> {
  const native = (
    globalThis as {
      BarcodeDetector?: {
        new (o: { formats: string[] }): Detector;
        getSupportedFormats?: () => Promise<string[]>;
      };
    }
  ).BarcodeDetector;
  if (native?.getSupportedFormats) {
    const supported = await native.getSupportedFormats();
    if (formats.every((f) => supported.includes(f))) return new native({ formats });
  }
  const [{ BarcodeDetector, setZXingModuleOverrides }, { default: wasmUrl }] = await Promise.all([
    import("barcode-detector/ponyfill"),
    import("zxing-wasm/reader/zxing_reader.wasm?url"),
  ]);
  setZXingModuleOverrides({
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? wasmUrl : prefix + path,
  });
  return new BarcodeDetector({ formats: formats as never });
}

/**
 * A live camera view that reports each barcode it reads. `accept` decides
 * which values count (for example, only book ISBNs), so a stray QR code or a
 * price sticker is ignored.
 */
/** A short, quiet beep, so a scan is noticed on phones that cannot vibrate (iPhone). */
function beep(): void {
  try {
    const Audio =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Audio) return;
    const ctx = new Audio();
    const tone = ctx.createOscillator();
    const volume = ctx.createGain();
    tone.frequency.value = 880;
    volume.gain.value = 0.08;
    tone.connect(volume).connect(ctx.destination);
    tone.start();
    tone.stop(ctx.currentTime + 0.12);
    tone.onended = () => void ctx.close();
  } catch {
    // Sound is a nice-to-have.
  }
}

function cameraError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError") {
    return "The camera is blocked. Allow camera access for this site (on iPhone: Settings › Safari › Camera), then try again, or type the number instead.";
  }
  if (name === "NotFoundError") return "No camera was found. Type the number instead.";
  if (!window.isSecureContext)
    return "The camera only works on a secure (https) address. Type the number instead.";
  return "The camera could not start. Try again, or type the number instead.";
}

/**
 * A live camera view that reports each barcode it reads. `accept` decides
 * which values count (for example, only book ISBNs), so a stray QR code or a
 * price sticker is ignored. After a scan it pauses until `paused` turns false,
 * so one book is never reported twice.
 */
export function Scanner({
  formats,
  accept,
  onScan,
  label,
  paused = false,
}: {
  formats: string[];
  accept: (value: string) => string | null;
  onScan: (value: string) => void;
  label: string;
  paused?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const formatKey = formats.join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt restarts the camera on "Try again"
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let last = { value: "", at: 0 };
    const element = video.current;
    setReady(false);

    const stopStream = (s: MediaStream | null) => {
      for (const track of s?.getTracks() ?? []) track.stop();
    };

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(cameraError(new Error("unsupported")));
        return;
      }
      try {
        const detector = await createDetector(formatKey.split(","));
        const opened = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        // The scanner closed while the camera was starting: turn it straight off.
        if (stopped || !element) {
          stopStream(opened);
          return;
        }
        stream = opened;
        element.srcObject = stream;
        await element.play();
        setReady(true);
        const tick = async () => {
          if (stopped) return;
          if (!pausedRef.current) {
            try {
              for (const code of await detector.detect(element)) {
                const value = acceptRef.current(code.rawValue);
                // The same code stays in view for a while: report it once every few seconds.
                if (value && (value !== last.value || Date.now() - last.at > 3000)) {
                  last = { value, at: Date.now() };
                  navigator.vibrate?.(60);
                  beep();
                  setAnnouncement(`Scanned ${value}`);
                  onScanRef.current(value);
                  break; // one book per scan
                }
              }
            } catch {
              // A frame that could not be read; try the next one.
            }
          }
          timer = setTimeout(tick, 200);
        };
        void tick();
      } catch (e) {
        setError(cameraError(e));
      }
    };
    void start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stopStream(stream);
      if (element) element.srcObject = null;
    };
  }, [formatKey, attempt]);

  return (
    <div className="scanner">
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      {error ? (
        <div className="alert alert--error" role="alert">
          <p style={{ margin: "0 0 0.5rem" }}>{error}</p>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              setError("");
              setAttempt((a) => a + 1);
            }}
          >
            Try the camera again
          </button>
        </div>
      ) : (
        <div className={`scanner__frame${paused ? " scanner__frame--paused" : ""}`}>
          <video ref={video} muted playsInline aria-label={label} />
          <div className="scanner__guide" aria-hidden="true" />
          {!ready && <p className="scanner__status">Starting the camera…</p>}
          {ready && (
            <p className="scanner__status">Point the camera at the barcode on the back cover</p>
          )}
        </div>
      )}
    </div>
  );
}
