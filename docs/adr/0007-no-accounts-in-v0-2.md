---
status: accepted
---

# No accounts in v0.2

The account system (password sign-in, account sessions, root bootstrap and web-of-trust vouching) was built but never used by the game or the client. On Cloudflare's free plan it would have cost scrypt hashing inside a Durable Object, account storage and login throttling. We drop accounts for the migration: creating or joining a game needs only a join code and a name, and a per-game seat cookie handles reconnecting.

## Considered Options

- **Keep accounts:** rejected, because it carries real platform cost for a feature nothing uses.
- **Host passphrase for creating games:** kept as the fallback if strangers creating games becomes a problem. It would be one operator-set secret, with no accounts and no hashing.

## Consequences

- **Anyone can create games:** anyone who knows a deployment's URL can create games and use its free-plan quota.
- **Future accounts:** bringing accounts back later is a new effort with its own storage and authentication decisions.
