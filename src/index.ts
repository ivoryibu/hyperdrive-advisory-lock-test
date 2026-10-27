import { Client } from 'pg';

export interface Env {
  HYPERDRIVE: Hyperdrive;
  NEON_DIRECT_URL: string;
}

type Step = Record<string, unknown>;

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Access-Control-Allow-Origin': '*' },
  });
}

function targets(env: Env, target: string): { label: string; cs: string; ssl?: object } {
  if (target === 'direct') {
    return { label: 'direct-neon', cs: env.NEON_DIRECT_URL, ssl: { rejectUnauthorized: false } };
  }
  return { label: 'hyperdrive', cs: env.HYPERDRIVE.connectionString };
}

function key(name: string): number {
  return 1000000000 + ((Date.now() + name.length * 7919) % 1000000000);
}

async function connect(cs: string, ssl?: object): Promise<Client> {
  const c = new Client({ connectionString: cs, ...(ssl ? { ssl } : {}) });
  await c.connect();
  return c;
}

async function end(c: Client | null) {
  if (!c) return;
  try {
    await c.end();
  } catch {}
}

async function pid(c: Client): Promise<number> {
  const r = await c.query('SELECT pg_backend_pid() AS pid');
  return r.rows[0].pid as number;
}

function stepOf(name: string, fields: Record<string, unknown>): Step {
  return { step: name, ...fields };
}

async function runXactTest(cs: string, ssl?: object): Promise<Step[]> {
  const steps: Step[] = [];
  const k = key('xact');
  let a: Client | null = null;
  let b: Client | null = null;
  try {
    a = await connect(cs, ssl);
    const aPid = await pid(a);
    await a.query('BEGIN');
    const lockA = await a.query('SELECT pg_advisory_xact_lock($1) AS locked', [k]);
    steps.push(stepOf('A: BEGIN + pg_advisory_xact_lock', {
      ok: true,
      lock_acquired: lockA.rows[0].locked === undefined ? true : true,
      backend_pid: aPid,
    }));

    b = await connect(cs, ssl);
    const tryB = await b.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [k]);
    steps.push(stepOf('B: pg_try_advisory_xact_lock while A holds', {
      acquired: tryB.rows[0].locked,
      expected: false,
      match: tryB.rows[0].locked === false,
    }));

    const t0 = Date.now();
    try {
      await b.query('BEGIN');
      await b.query("SET LOCAL lock_timeout = '1s'");
      await b.query('SELECT pg_advisory_xact_lock($1) AS locked', [k]);
      steps.push(stepOf('B: blocking pg_advisory_xact_lock with 1s lock_timeout', {
        result: 'ACQUIRED (unexpected: lock did not block)',
        ms: Date.now() - t0,
      }));
      await b.query('ROLLBACK');
    } catch (e: any) {
      steps.push(stepOf('B: blocking pg_advisory_xact_lock with 1s lock_timeout', {
        result: 'blocked until timeout (expected)',
        ms: Date.now() - t0,
        error: String(e?.message ?? e),
        code: e?.code,
      }));
      try { await b.query('ROLLBACK'); } catch {}
    }

    const tryB2 = await b.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [k]);
    steps.push(stepOf('B: try again while A still holds', {
      acquired: tryB2.rows[0].locked,
      expected: false,
      match: tryB2.rows[0].locked === false,
    }));

    await a.query('COMMIT');

    const tryB3 = await b.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [k]);
    steps.push(stepOf('B: try after A COMMIT', {
      acquired: tryB3.rows[0].locked,
      expected: true,
      match: tryB3.rows[0].locked === true,
    }));
    if (tryB3.rows[0].locked) await b.query('COMMIT');
  } catch (e: any) {
    steps.push(stepOf('unexpected error', { error: String(e?.message ?? e), code: e?.code }));
  } finally {
    try { if (a) await a.query('ROLLBACK').catch(() => {}); } catch {}
    await end(a);
    await end(b);
  }
  return steps;
}

async function runSessionTest(cs: string, ssl?: object): Promise<Step[]> {
  const steps: Step[] = [];
  const k = key('session');
  let a: Client | null = null;
  let b: Client | null = null;
  let c: Client | null = null;
  try {
    a = await connect(cs, ssl);
    const aPid1 = await pid(a);
    try {
      const lockA = await a.query('SELECT pg_advisory_lock($1) AS locked', [k]);
      steps.push(stepOf('A: pg_advisory_lock (session, autocommit)', {
        ok: true,
        result: lockA.rows[0].locked === undefined ? 'acquired' : String(lockA.rows[0].locked),
        backend_pid: aPid1,
      }));
    } catch (e: any) {
      steps.push(stepOf('A: pg_advisory_lock (session, autocommit)', {
        ok: false,
        error: String(e?.message ?? e),
        code: e?.code,
      }));
      return steps;
    }

    const aPid2 = await pid(a);
    steps.push(stepOf('A: backend pid on next query (same client)', {
      pid_before: aPid1,
      pid_after: aPid2,
      physical_connection_swapped: aPid1 !== aPid2,
    }));

    const unlockA = await a.query('SELECT pg_advisory_unlock($1) AS unlocked', [k]);
    steps.push(stepOf('A: pg_advisory_unlock in separate query, same client', {
      unlocked: unlockA.rows[0].unlocked,
      interpretation: unlockA.rows[0].unlocked ? 'unlock worked on same session' : 'lock not held by this session (lost across pool)',
    }));

    const lockA2 = await a.query('SELECT pg_advisory_lock($1) AS locked', [k]);
    steps.push(stepOf('A: re-acquire session lock', { acquired: true, result: lockA2.rows[0].locked === undefined ? 'acquired' : String(lockA2.rows[0].locked) }));

    b = await connect(cs, ssl);
    const tryB = await b.query('SELECT pg_try_advisory_lock($1) AS locked', [k]);
    steps.push(stepOf('B: pg_try_advisory_lock while A connected and holds', {
      acquired: tryB.rows[0].locked,
      expected_if_session_locks_work: false,
      interpretation: tryB.rows[0].locked
        ? 'lock did NOT block another session (no exclusion through pool)'
        : 'lock blocked other session (exclusion works)',
    }));

    await end(a);
    a = null;

    const tryB2 = await b.query('SELECT pg_try_advisory_lock($1) AS locked', [k]);
    steps.push(stepOf('B: try again after A disconnects', {
      acquired: tryB2.rows[0].locked,
      interpretation: tryB2.rows[0].locked
        ? 'lock released when A disconnected (reset on pool return) or was never held'
        : 'lock still held after A disconnected (leaked on pooled backend)',
    }));
    if (tryB2.rows[0].locked) {
      await b.query('SELECT pg_advisory_unlock($1)', [k]);
    }

    c = await connect(cs, ssl);
    await c.query('SELECT pg_advisory_unlock_all()');
    steps.push(stepOf('cleanup: pg_advisory_unlock_all on fresh client', { ok: true }));
  } catch (e: any) {
    steps.push(stepOf('unexpected error', { error: String(e?.message ?? e), code: e?.code }));
  } finally {
    await end(a);
    await end(b);
    await end(c);
  }
  return steps;
}

async function runPidTest(cs: string, ssl?: object): Promise<Step[]> {
  const steps: Step[] = [];
  try {
    const c = await connect(cs, ssl);
    const pids: number[] = [];
    for (let i = 0; i < 5; i++) {
      pids.push(await pid(c));
    }
    const unique = [...new Set(pids)];
    steps.push(stepOf('backend pid across 5 sequential autocommit queries on one client', {
      pids,
      distinct_backends: unique.length,
      stable: unique.length === 1,
    }));
    await end(c);
  } catch (e: any) {
    steps.push(stepOf('unexpected error', { error: String(e?.message ?? e) }));
  }
  return steps;
}

async function runLocksView(cs: string, ssl?: object): Promise<Step[]> {
  try {
    const c = await connect(cs, ssl);
    const r = await c.query(
      "SELECT l.pid, l.objid, l.granted, a.state, a.state_change, a.application_name, a.client_addr FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' ORDER BY l.pid",
    );
    await end(c);
    return [{ step: 'pg_locks (advisory)', rows: r.rows }];
  } catch (e: any) {
    return [{ step: 'unexpected error', error: String(e?.message ?? e) }];
  }
}

async function runLeakTest(cs: string, ssl?: object): Promise<Step[]> {
  const steps: Step[] = [];
  const k = key('leak');
  let a: Client | null = null;
  try {
    a = await connect(cs, ssl);
    const holderPid = await pid(a);
    await a.query('SELECT pg_advisory_lock($1) AS locked', [k]);
    steps.push(stepOf('A: acquired session lock', { backend_pid: holderPid }));
    await end(a);
    a = null;
    steps.push(stepOf('A: disconnected without unlocking', { backend_pid: holderPid }));

    for (let i = 0; i < 15; i++) {
      const t0 = Date.now();
      let probe: Client | null = null;
      let acquired: boolean | null = null;
      let locks: unknown = null;
      try {
        probe = await connect(cs, ssl);
        const r = await probe.query('SELECT pg_try_advisory_lock($1) AS locked', [k]);
        acquired = r.rows[0].locked;
        if (acquired) {
          await probe.query('SELECT pg_advisory_unlock($1)', [k]);
        }
        const l = await probe.query(
          "SELECT l.pid, l.granted, a.state, a.application_name FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory'",
        );
        locks = l.rows;
      } catch (e: any) {
        locks = String(e?.message ?? e);
      } finally {
        await end(probe);
      }
      steps.push(stepOf(`probe ${i + 1}`, {
        t: Date.now() - t0,
        acquired,
        advisory_locks: locks,
      }));
      if (acquired) break;
      await new Promise((r) => setTimeout(r, 4000));
    }
  } catch (e: any) {
    steps.push(stepOf('unexpected error', { error: String(e?.message ?? e) }));
  } finally {
    await end(a);
  }
  return steps;
}

async function runSessionIdleTest(cs: string, ssl?: object, idleMs = 30000): Promise<Step[]> {
  const steps: Step[] = [];
  const k = key('idle');
  let a: Client | null = null;
  let b: Client | null = null;
  try {
    a = await connect(cs, ssl);
    const pid1 = await pid(a);
    await a.query('SELECT pg_advisory_lock($1) AS locked', [k]);
    steps.push(stepOf('A: acquired session lock', { backend_pid: pid1 }));

    await new Promise((r) => setTimeout(r, idleMs));

    const pid2 = await pid(a);
    steps.push(stepOf(`A: after ${idleMs}ms idle (same client)`, {
      pid_before: pid1,
      pid_after: pid2,
      physical_connection_swapped: pid1 !== pid2,
    }));

    const unlock = await a.query('SELECT pg_advisory_unlock($1) AS unlocked', [k]);
    steps.push(stepOf('A: unlock after idle', {
      unlocked: unlock.rows[0].unlocked,
      interpretation: unlock.rows[0].unlocked
        ? 'lock survived idle on same client'
        : 'lock silently lost while client was idle (connection swapped/reset)',
    }));

    const relock = await a.query('SELECT pg_advisory_lock($1) AS locked', [k]);
    steps.push(stepOf('A: re-acquire', { ok: relock.rows[0].locked !== false }));

    b = await connect(cs, ssl);
    const tryB = await b.query('SELECT pg_try_advisory_lock($1) AS locked', [k]);
    steps.push(stepOf('B: try while A idle-but-connected and holds', {
      acquired: tryB.rows[0].locked,
      expected_if_session_locks_work: false,
    }));
    if (tryB.rows[0].locked) {
      await b.query('SELECT pg_advisory_unlock($1)', [k]);
    }
    await a.query('SELECT pg_advisory_unlock($1)', [k]);
  } catch (e: any) {
    steps.push(stepOf('unexpected error', { error: String(e?.message ?? e) }));
  } finally {
    await end(a);
    await end(b);
  }
  return steps;
}

async function runCleanTest(cs: string, ssl?: object): Promise<Step[]> {
  const steps: Step[] = [];
  let final: unknown = null;
  try {
    for (let i = 0; i < 10; i++) {
      const c = await connect(cs, ssl);
      const p = await pid(c);
      await c.query('SELECT pg_advisory_unlock_all()');
      await end(c);
      steps.push({ step: `client ${i + 1}`, backend_pid: p, ran: 'pg_advisory_unlock_all' });
    }
    const c = await connect(cs, ssl);
    const r = await c.query(
      "SELECT l.pid, l.objid, l.granted, a.state, a.application_name FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory'",
    );
    final = r.rows;
    await end(c);
  } catch (e: any) {
    steps.push(stepOf('unexpected error', { error: String(e?.message ?? e) }));
  }
  return [...steps, { step: 'final pg_locks (advisory)', rows: final }];
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const target = url.searchParams.get('target') ?? 'hd';
    const t = targets(env, target);

    if (url.pathname === '/xact') {
      return json({ target: t.label, key_scope: 'unique per run', steps: await runXactTest(t.cs, t.ssl) });
    }
    if (url.pathname === '/session') {
      return json({ target: t.label, key_scope: 'unique per run', steps: await runSessionTest(t.cs, t.ssl) });
    }
    if (url.pathname === '/pid') {
      return json({ target: t.label, steps: await runPidTest(t.cs, t.ssl) });
    }
    if (url.pathname === '/locks') {
      return json({ target: t.label, steps: await runLocksView(t.cs, t.ssl) });
    }
    if (url.pathname === '/leak') {
      return json({ target: t.label, steps: await runLeakTest(t.cs, t.ssl) });
    }
    if (url.pathname === '/session-idle') {
      const idleMs = Number(url.searchParams.get('idle') ?? 30000);
      return json({ target: t.label, steps: await runSessionIdleTest(t.cs, t.ssl, idleMs) });
    }
    if (url.pathname === '/clean') {
      return json({ target: t.label, steps: await runCleanTest(t.cs, t.ssl) });
    }
    return json({
      usage: ['/xact?target=hd|direct', '/session?target=hd|direct', '/pid?target=hd|direct', '/locks?target=hd|direct'],
    });
  },
} satisfies ExportedHandler<Env>;
