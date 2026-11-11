import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { api, errorMessage } from "./api.ts";

export type Role = "admin" | "staff" | "member";

export interface Me {
  user: { id: string; email: string; name: string; hasPasskey: boolean } | null;
  library: { name: string } | null;
  setupNeeded: boolean;
  setupCodeRequired?: boolean;
  membership?: {
    role: Role;
    family: { id: string; name: string; status: "active" | "pending" | "deactivated" } | null;
  } | null;
}

type SessionState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; me: Me };

const SessionContext = createContext<{
  state: SessionState;
  /** Reloads who is signed in, and returns it (null if the library could not be reached). */
  refresh: () => Promise<Me | null>;
} | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const refresh = useCallback(async () => {
    try {
      const me = await api<Me>("/me");
      setState({ status: "ready", me });
      return me;
    } catch (error) {
      setState({ status: "error", message: errorMessage(error) });
      return null;
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return <SessionContext.Provider value={{ state, refresh }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}

/** True for staff and admins. */
export function isStaff(me: Me): boolean {
  const role = me.membership?.role;
  return role === "admin" || role === "staff";
}
