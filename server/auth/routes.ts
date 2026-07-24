/**
 * The auth HTTP surface (BACKLOG.md #20): register, sign in/out, "who am I", and
 * vouch — mounted at `/api/auth` by `createServer`. This is the only REST-ish
 * corner of an otherwise Socket.IO server (docs/arc42.md §3), so it keeps its own
 * `express.json()` body parsing and cookie handling scoped to the router rather
 * than adding global middleware.
 *
 * A successful register/login mints a {@link SessionCodec} token and sets it as an
 * **httpOnly** cookie, so client JavaScript can't read the session and it rides
 * along automatically on later requests. Identity on every authenticated route is
 * taken from that signed cookie — never from the request body — mirroring the
 * socket layer's "identity is server-authoritative" rule.
 */
import express, { type Request, type Response, type Router } from 'express';
import { AuthError, type Account, type AccountStore } from './store.ts';
import type { SessionCodec } from './session.ts';

/** The session cookie name. */
export const SESSION_COOKIE = 'session';

interface AuthRouterOptions {
  store: AccountStore;
  sessions: SessionCodec;
  /**
   * Whether to mark the session cookie `Secure`. Defaults to following the
   * request (`req.secure`) so it is set behind Caddy's HTTPS but omitted over
   * plain HTTP in dev/tests, where a `Secure` cookie would be dropped.
   */
  secureCookie?: boolean;
}

/** HTTP status for each recoverable {@link AuthError}. */
const STATUS_BY_CODE: Record<AuthError['code'], number> = {
  name_required: 400,
  username_required: 400,
  password_required: 400,
  username_taken: 409,
  account_not_found: 404,
  self_vouch: 400,
};

/** An account plus its computed trust, the shape every auth route returns. */
async function present(
  store: AccountStore,
  account: Account,
): Promise<Account & { trusted: boolean }> {
  return { ...account, trusted: await store.isTrusted(account.id) };
}

/** Parse a `Cookie` header into a name→value map. Tolerant of odd whitespace. */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Resolve the caller's session token from the request: the session cookie first,
 * then a `Authorization: Bearer <token>` header (handy for API clients and
 * tests). Returns the account id if the token verifies, else `null`.
 */
function sessionAccountId(req: Request, sessions: SessionCodec): string | null {
  const cookies = parseCookies(req.headers.cookie);
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '');
  const token = cookies[SESSION_COOKIE] ?? bearer?.[1];
  return sessions.verify(token)?.accountId ?? null;
}

/** Send an {@link AuthError} as a JSON error with its mapped status. */
function sendAuthError(res: Response, err: unknown): boolean {
  if (err instanceof AuthError) {
    res.status(STATUS_BY_CODE[err.code]).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

/**
 * Build the `/api/auth` router. `store` persists accounts + trust; `sessions`
 * mints and verifies the cookie token.
 */
export function createAuthRouter({
  store,
  sessions,
  secureCookie,
}: AuthRouterOptions): Router {
  const router = express.Router();
  router.use(express.json());

  // Set the httpOnly session cookie for a freshly authenticated account.
  const setSession = (req: Request, res: Response, account: Account): void => {
    res.cookie(SESSION_COOKIE, sessions.sign(account.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie ?? req.secure,
      path: '/',
      maxAge: sessions.ttlSeconds * 1000,
    });
  };

  // The signed-in account, or null. Shared by /me and /vouch.
  const requireAccount = async (
    req: Request,
    res: Response,
  ): Promise<Account | null> => {
    const id = sessionAccountId(req, sessions);
    const account = id ? await store.getById(id) : null;
    if (!account) {
      res.status(401).json({ error: 'Not signed in', code: 'unauthenticated' });
      return null;
    }
    return account;
  };

  // Create an account and sign it in.
  router.post('/register', async (req: Request, res: Response) => {
    const { name, username, password } = (req.body ?? {}) as Record<string, unknown>;
    try {
      const account = await store.createAccount({
        name: typeof name === 'string' ? name : '',
        username: typeof username === 'string' ? username : '',
        password: typeof password === 'string' ? password : '',
      });
      setSession(req, res, account);
      res.status(201).json({ account: await present(store, account) });
    } catch (err) {
      if (sendAuthError(res, err)) return;
      throw err;
    }
  });

  // Sign in with username + password.
  router.post('/login', async (req: Request, res: Response) => {
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    const account =
      typeof username === 'string' && typeof password === 'string'
        ? await store.verifyCredentials(username, password)
        : null;
    if (!account) {
      res.status(401).json({ error: 'Invalid username or password', code: 'invalid_credentials' });
      return;
    }
    setSession(req, res, account);
    res.json({ account: await present(store, account) });
  });

  // Sign out: clear the cookie. Always succeeds (idempotent).
  router.post('/logout', (req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // The current account, from the session cookie.
  router.get('/me', async (req: Request, res: Response) => {
    const account = await requireAccount(req, res);
    if (!account) return;
    res.json({ account: await present(store, account) });
  });

  // Vouch for another account. The voucher is always the signed-in caller — the
  // body only names the vouchee (by id or username), never the voucher — so a
  // root (or any trusted account) extends trust outward but no one can forge a
  // vouch *from* someone else. Root's ability to vouch is the acceptance
  // criterion; the same path serves any account.
  router.post('/vouch', async (req: Request, res: Response) => {
    const voucher = await requireAccount(req, res);
    if (!voucher) return;
    const { accountId, username } = (req.body ?? {}) as Record<string, unknown>;

    const vouchee =
      typeof accountId === 'string'
        ? await store.getById(accountId)
        : typeof username === 'string'
          ? await store.getByUsername(username)
          : null;
    if (!vouchee) {
      res.status(404).json({ error: 'No such account', code: 'account_not_found' });
      return;
    }
    try {
      await store.vouch(voucher.id, vouchee.id);
      res.json({ ok: true, vouchee: await present(store, vouchee) });
    } catch (err) {
      if (sendAuthError(res, err)) return;
      throw err;
    }
  });

  return router;
}
