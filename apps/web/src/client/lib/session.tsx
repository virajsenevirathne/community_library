import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { api, errorMessage } from "./api.ts";
import { libraryBase, useLocation } from "./router.tsx";

export type Role = "admin" | "staff" | "member";

export interface LibraryLink {
  slug: string;
  name: string;
  role: Role;
}

export interface Me {
  user: {
    id: string;
    email: string;
    name: string;
    hasPasskey: boolean;
    /** How reminders reach this person. */
    notifyBy: "email" | "push" | "both";
    /** Devices showing this person's notifications. */
    pushDevices: number;
  } | null;
  /** The site's web push key; null when phone notifications are off. */
  pushKey?: string | null;
  /** The library this page belongs to, or null on site-wide pages. */
  library: {
    name: string;
    slug: string;
    status: "active" | "paused";
    /** False until its first admin has accepted the terms and chosen how returns work. */
    setUp: boolean;
    /** The site's owner, here for support (not a member). */
    support: boolean;
  } | null;
  /** True for the person who runs the whole site. */
  owner?: boolean;
  /** The site's own name, for pages outside any library. */
  siteName?: string;
  /** Where people ask for a library of their own (front page), if set. */
  contactEmail?: string | null;
  /** Every library the signed-in person belongs to. */
  libraries: LibraryLink[];
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
  | { status: "ready"; me: Me; base: string | null };

const SessionContext = createContext<{
  state: SessionState;
  /** Reloads who is signed in, and returns it (null if the library could not be reached). */
  refresh: () => Promise<Me | null>;
} | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const refresh = useCallback(async () => {
    try {
      const base = libraryBase();
      const me = await api<Me>("/me");
      setState({ status: "ready", me, base });
      return me;
    } catch (error) {
      setState({ status: "error", message: errorMessage(error) });
      return null;
    }
  }, []);
  // Moving to another library's pages reloads who the person is there.
  const { base } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: base is the trigger, not an input
  useEffect(() => {
    void refresh();
  }, [refresh, base]);
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
