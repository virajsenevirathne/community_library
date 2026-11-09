import { useEffect, useState } from "react";

type Health =
  | { state: "loading" }
  | { state: "ok"; library: string }
  | { state: "error"; message: string };

export function App() {
  const [health, setHealth] = useState<Health>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json()) as { ok: boolean; library?: string; database?: string };
        if (body.ok && body.library) {
          setHealth({ state: "ok", library: body.library });
        } else {
          setHealth({ state: "error", message: `Database: ${body.database ?? "unknown"}` });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setHealth({ state: "error", message: String(error) });
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="page">
      <h1>{health.state === "ok" ? health.library : "Community Library"}</h1>
      <p className="lead">Scan a book's QR sticker to borrow or return it.</p>
      <p className="status" role="status">
        {health.state === "loading" && "Checking the library…"}
        {health.state === "ok" && "The library is open."}
        {health.state === "error" && `The library is unavailable. ${health.message}`}
      </p>
    </main>
  );
}
