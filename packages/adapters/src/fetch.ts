/**
 * The platform's fetch, safe to keep as an object's property. Cloudflare
 * Workers refuses `this.fetcher(...)` when `fetcher` is the built-in fetch
 * itself ("Illegal invocation"): calling it through this wrapper is fine.
 */
export const platformFetch: typeof fetch = (input, init) => fetch(input, init);
