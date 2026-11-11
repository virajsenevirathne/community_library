/** An error from our API, with a message that can be shown to people as is. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Per-field problems, when the server lists them (such as settings). */
    readonly errors?: { field: string; message: string }[],
    /** The whole response body, for errors that carry details (such as books still out). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const OFFLINE_MESSAGE = "Could not reach the library. Check your connection and try again.";

/** Calls the API. Throws ApiError with a readable message on failure. */
export async function api<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      credentials: "same-origin",
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError(0, "offline", OFFLINE_MESSAGE);
  }
  const data = (await res.json().catch(() => null)) as {
    error?: string;
    message?: string;
    errors?: { field: string; message: string }[];
  } | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error ?? "error",
      data?.message ?? "Something went wrong. Please try again.",
      data?.errors,
      (data ?? undefined) as Record<string, unknown> | undefined,
    );
  }
  return data as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "";
  return "Something went wrong. Please try again.";
}
