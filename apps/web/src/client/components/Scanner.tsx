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

// One sound context for the page, created on the first tap: iPhones only play
// sound that starts from a person's tap.
let audio: AudioContext | null = null;
function unlockAudio() {
  try {
    const Audio =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    audio ??= Audio ? new Audio() : null;
    void audio?.resume();
  } catch {
    audio = null;
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", unlockAudio, { capture: true });
}

function tone(frequency: number, start: number, length: number) {
  if (!audio) return;
  const osc = audio.createOscillator();
  const volume = audio.createGain();
  osc.frequency.value = frequency;
  volume.gain.value = 0.25;
  osc.connect(volume).connect(audio.destination);
  osc.start(audio.currentTime + start);
  osc.stop(audio.currentTime + start + length);
}

/**
 * A short sound (and a buzz, where phones allow) so a scan is noticed without
 * looking: one high beep when it worked, two low beeps when it didn't.
 */
export function signal(kind: "ok" | "error") {
  try {
    if (kind === "ok") {
      tone(880, 0, 0.12);
      navigator.vibrate?.(60);
    } else {
      tone(330, 0, 0.15);
      tone(330, 0.22, 0.15);
      navigator.vibrate?.([120, 80, 120]);
    }
  } catch {
    // Sound is a nice-to-have.
  }
}

function cameraError(error: unknown, typeWhat: string): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError") {
    return `The camera is blocked. Allow camera access for this site (on iPhone: Settings › Safari › Camera), then try again, or type the ${typeWhat} instead.`;
  }
  if (name === "NotFoundError") return `No camera was found. Type the ${typeWhat} instead.`;
  if (!window.isSecureContext) {
    return `The camera only works on a secure (https) address. Type the ${typeWhat} instead.`;
  }
  return `The camera could not start. Try again, or type the ${typeWhat} instead.`;
}

/**
 * A live camera view that reports each barcode it reads. `accept` decides
 * which values count (for example, only book ISBNs), so a stray QR code or a
 * price sticker is ignored. While `paused` is true nothing is reported, so a
 * page can pause it while it handles a scan.
 */
export function Scanner({
  formats,
  accept,
  onScan,
  label,
  hint,
  paused = false,
  typeWhat = "number",
  sound = true,
}: {
  formats: string[];
  accept: (value: string) => string | null;
  onScan: (value: string) => void;
  label: string;
  /** What to point the camera at, shown over the camera view. */
  hint: string;
  paused?: boolean;
  /** What to type instead if the camera fails, such as "code". */
  typeWhat?: string;
  /** Beep on every scan. Turn off when the page signals the result itself. */
  sound?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const soundRef = useRef(sound);
  soundRef.current = sound;
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
        setError(cameraError(new Error("unsupported"), typeWhat));
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
                  if (soundRef.current) signal("ok");
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
        setError(cameraError(e, typeWhat));
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
          <p className="scanner__status">{ready ? hint : "Starting the camera…"}</p>
        </div>
      )}
    </div>
  );
}
