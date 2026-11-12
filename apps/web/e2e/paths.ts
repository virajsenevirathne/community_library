import { resolve } from "node:path";

/** Where the browser tests keep their database, server output and sessions. */
export const STATE = resolve(import.meta.dirname, "../.e2e-state");
export const SERVER_LOG = resolve(STATE, "server.log");
