export function checkBearer(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  // Constant-time compare to avoid timing leaks (length differs → still false fast)
  const got = m[1];
  if (got.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) {
    diff |= got.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return diff === 0;
}
