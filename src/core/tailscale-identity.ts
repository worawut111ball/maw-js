// Kept apart from server.ts so tests can import it without loading the whole server.
/** Tailscale Serve sets Tailscale-User-Login after it has authenticated the tailnet user, and it reaches maw from
 *  127.0.0.1. From any other address the header is plain text anyone on the network could send → drop it, so it
 *  can never stand in for the phone token. */
export function dropForgedTailscaleIdentity(req: Request, remote: string | undefined): Request {
  if (!req.headers.has("tailscale-user-login")) return req;
  if (remote && /^(127\.|::1$|::ffff:127\.)/.test(remote)) return req;
  const h = new Headers(req.headers);
  for (const k of ["tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic"]) h.delete(k);
  return new Request(req, { headers: h });
}
