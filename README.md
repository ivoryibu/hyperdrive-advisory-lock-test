# Hyperdrive advisory lock test

Empirical test of PostgreSQL advisory lock support through [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/), run against [cloudflare/cloudflare-docs#34640](https://github.com/cloudflare/cloudflare-docs/issues/34640).

## TL;DR (tested 2026-10-27, Hyperdrive transaction pooling → Neon Postgres)

| Lock type | Command | Works while client connected | Correct after `COMMIT` / disconnect |
| --- | --- | --- | --- |
| Transaction-level | `pg_advisory_xact_lock`, `pg_advisory_xact_lock_shared`, `pg_try_advisory_xact_lock`, `pg_try_advisory_xact_lock_shared` (incl. two-key `(int, int)` overloads) | Yes — held for the transaction, blocking and shared-compatible semantics correct (`55P03` on `lock_timeout`) | Yes — released at transaction end, before the connection returns to the pool |
| Session-level | `pg_advisory_lock` | Yes — sticky backend, unlock and cross-session exclusion work | **No — the lock leaks on the pooled backend after the client disconnects** |

- Hyperdrive does **not** reject any advisory lock commands: session-level locks fail silently.
- A session-level lock held by a disconnected client stays `granted` on an idle pooled connection (`application_name = Cloudflare Hyperdrive`), blocking unrelated sessions for a long time (observed >10 minutes), until that pooled connection is reused with an `unlock`, closed by the pool, or the origin restarts.
- A later client assigned that same pooled connection **inherits** the orphaned lock (`pg_try_advisory_lock` returns `true` for a session that never acquired it), producing false positives.
- Transaction-level locks (`pg_advisory_xact_lock` inside an explicit `BEGIN`/`COMMIT`) behave identically through Hyperdrive and through a direct connection: acquired, blocking, and released at `COMMIT` before the connection returns to the pool.

Conclusion for the docs: **transaction-level advisory locks are safe to use through Hyperdrive inside an explicit transaction; session-level advisory locks are unsupported** (they are not rejected, but silently break under pooling).

## Test setup

- Worker deployed to Cloudflare Workers, connecting through a Hyperdrive binding (transaction pooling mode) and, as a control, directly to a Neon Postgres endpoint.
- Driver: `pg` (node-postgres) v8. Each test step uses independent `pg` clients; advisory lock keys are randomized per run to avoid collisions.
- The lock-holder client acquires the lock and either stays connected or disconnects without unlocking; probe clients attempt `pg_try_advisory_lock` and a blocking acquire with `SET LOCAL lock_timeout = '1s'`.
- `pg_backend_pid()` is tracked across queries to detect physical connection reassignment. `pg_locks`/`pg_stat_activity` identify the holder (`application_name = Cloudflare Hyperdrive`).

## Routes

| Route | Test |
| --- | --- |
| `GET /pid?target=hd\|direct` | Backend pid stability across sequential autocommit queries on one client |
| `GET /xact?target=hd\|direct` | Transaction-level lock lifecycle (`BEGIN` → block probes → `COMMIT`) |
| `GET /xact-family?target=hd\|direct` | Full transaction-level family: shared/try variants, shared-vs-exclusive compatibility, two-key `(int, int)` overloads |
| `GET /session?target=hd\|direct` | Session-level lock lifecycle (acquire, unlock, exclusion, disconnect) |
| `GET /leak?target=hd\|direct` | Acquire session lock, disconnect, poll `pg_try_advisory_lock` + `pg_locks` until acquired |
| `GET /session-idle?target=hd\|direct&idle=30000` | Session lock survival across client idle time |
| `GET /clean?target=hd\|direct` | Cycle fresh clients running `pg_advisory_unlock_all()` to clear orphans |
| `GET /locks?target=hd\|direct` | Dump `pg_locks` (advisory) with `pg_stat_activity` state |

## Reproduce

1. Create a Hyperdrive config pointing at your PostgreSQL database and put its ID in `wrangler.jsonc`.
2. Set `NEON_DIRECT_URL` (or your own direct connection string) at deploy time rather than committing it:

   ```sh
   npx wrangler deploy --var NEON_DIRECT_URL:"postgresql://user:password@host/db?sslmode=require"
   ```

3. Call the routes above (`target=hd` for Hyperdrive, `target=direct` for the control).
4. To clean up orphaned locks, call `/clean` until `pg_locks` (advisory) is empty.

## Recorded results

Raw responses from the 2026-10-27 run are in [`results/`](./results/) (client 1–5 entries omitted from `hyperdrive-clean.json`; the excerpt shown covers the clients after the orphan appeared, including the one that inherited and released it):

- `direct-*.json` — control: plain Postgres behavior over a direct connection.
- `hyperdrive-*.json` — behavior through Hyperdrive.

Key evidence:

- `hyperdrive-xact.json` — transaction-level locks fully correct through Hyperdrive.
- `hyperdrive-xact-family.json` — all four transaction-level functions (including `pg_try_advisory_xact_lock_shared` and two-key overloads) with correct shared/exclusive semantics through Hyperdrive; `direct-xact-family.json` is the matching control.
- `hyperdrive-leak.json` — after the holder disconnects, `pg_locks` still shows the lock `granted` on an idle backend with `application_name = Cloudflare Hyperdrive`; the next probe "acquires" only because it was assigned that same pooled connection.
- `hyperdrive-locks-orphan-persists.json` — the orphaned lock persists minutes after disconnect.
- `hyperdrive-clean.json` — a later client assigned to the leaked backend (pid 1897) releases the orphan via `pg_advisory_unlock_all()`; sequential fresh clients map to multiple distinct backends (Hyperdrive multiplexing).

## Related

- Issue: [cloudflare/cloudflare-docs#34640 — Clarify whether pg_advisory_xact_lock is supported](https://github.com/cloudflare-docs/cloudflare-docs/issues/34640)
- Earlier docs context: [#11958](https://github.com/cloudflare/cloudflare-docs/pull/11958) recommended `pg_advisory_xact_lock`; [#15031](https://github.com/cloudflare/cloudflare-docs/pull/15031) removed the recommendation; [#19035](https://github.com/cloudflare/cloudflare-docs/pull/19035) documented `SET` behavior in transaction mode.
- Corroborating production observation: [emdash-cms/emdash#1744](https://github.com/emdash-cms/emdash/issues/1744) (PlanetScale Insights showed `pg_advisory_xact_lock` running under `application_name = Cloudflare Hyperdrive` with multi-second lock waits).
