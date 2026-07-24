/**
 * Root-account bootstrap (BACKLOG.md #20).
 *
 * Trust in the vouch graph flows out from a *root* account (see `./store.ts`), so
 * the deployment needs exactly one to exist before anyone can be vouched for.
 * {@link bootstrapRoot} seeds it idempotently: if a root already exists it does
 * nothing, so it is safe to run on every boot alongside the DB migrations.
 *
 * The root's credentials come from the environment (`ROOT_USERNAME`,
 * `ROOT_PASSWORD`, `ROOT_NAME`). When no `ROOT_PASSWORD` is configured a strong
 * random one is generated and returned to the caller **once**, to be logged at
 * boot — so a fresh self-hosted install always has a working, non-guessable root
 * login even if the operator didn't set a password, and never a silent default.
 */
import { randomBytes } from 'node:crypto';
import type { Account, AccountStore } from './store.ts';

/** Resolved root credentials for {@link bootstrapRoot}. */
export interface RootConfig {
  username: string;
  name: string;
  /** Explicit password; when absent one is generated. */
  password?: string;
}

/** The outcome of a bootstrap attempt. */
export interface BootstrapResult {
  /** Whether a root was created by this call (false if one already existed). */
  created: boolean;
  /** The created root account, present only when `created` is true. */
  account?: Account;
  /**
   * The generated password, present only when a root was created *and* no
   * `ROOT_PASSWORD` was supplied — surface it to the operator, then forget it.
   */
  generatedPassword?: string;
}

/**
 * Read the root config from the environment. `ROOT_USERNAME` defaults to `root`
 * and `ROOT_NAME` to `Root`; `ROOT_PASSWORD` is optional (generated when unset).
 */
export function resolveRootConfig(env: NodeJS.ProcessEnv = process.env): RootConfig {
  const username = env.ROOT_USERNAME?.trim() || 'root';
  const name = env.ROOT_NAME?.trim() || 'Root';
  const password = env.ROOT_PASSWORD?.trim() || undefined;
  return { username, name, ...(password ? { password } : {}) };
}

/** A URL-safe, high-entropy password for a generated root credential. */
function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Ensure a root account exists. Idempotent: returns `{ created: false }` when one
 * is already present. Otherwise creates the root from `config` (generating a
 * password when none was supplied) and returns it.
 */
export async function bootstrapRoot(
  store: AccountStore,
  config: RootConfig = resolveRootConfig(),
): Promise<BootstrapResult> {
  if (await store.hasRoot()) return { created: false };

  const generatedPassword = config.password ? undefined : generatePassword();
  const account = await store.createAccount({
    name: config.name,
    username: config.username,
    password: config.password ?? (generatedPassword as string),
    isRoot: true,
  });
  return { created: true, account, ...(generatedPassword ? { generatedPassword } : {}) };
}

/**
 * Bootstrap the root and log the outcome — the boot-time entry point. When a
 * password was generated it is logged once (the only time it is ever available)
 * so the operator can capture it; a supplied or pre-existing root logs nothing
 * sensitive.
 */
export async function bootstrapRootAndLog(
  store: AccountStore,
  config: RootConfig = resolveRootConfig(),
  logger: Pick<Console, 'log' | 'warn'> = console,
): Promise<BootstrapResult> {
  const result = await bootstrapRoot(store, config);
  if (!result.created) {
    logger.log(`root account "${config.username}" already exists`);
  } else if (result.generatedPassword) {
    logger.warn(
      `seeded root account "${config.username}" with a generated password: ` +
        `${result.generatedPassword}\n` +
        'Save it now — it will not be shown again. ' +
        'Set ROOT_PASSWORD to control the credential yourself.',
    );
  } else {
    logger.log(`seeded root account "${config.username}" from ROOT_PASSWORD`);
  }
  return result;
}
