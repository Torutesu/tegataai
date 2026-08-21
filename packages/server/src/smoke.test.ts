import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyExport } from '@tegata/verify';

/**
 * The quickstart in packages/server/README.md, executed. A README that has drifted
 * from the product is worse than none, because it is believed.
 */
describe('quickstart', () => {
  let dir: string;
  let dbPath: string;
  let key: string;
  let base: string;
  let server: ReturnType<typeof import('node:child_process').spawn>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tegata-smoke-'));
    dbPath = join(dir, 'tegata.db');

    const out = execFileSync('pnpm', ['bootstrap'], {
      encoding: 'utf8', env: { ...process.env, TEGATA_DB: dbPath },
    });
    key = /sk_live_[A-Za-z0-9_-]+/.exec(out)?.[0] ?? '';
    expect(key).not.toBe('');
    // The key is shown once and only its hash is kept, exactly as the README says.
    expect(out).toContain('cannot be shown again');

    const { spawn } = await import('node:child_process');
    const port = 8900 + Math.floor(Math.random() * 90);
    base = `http://127.0.0.1:${port}`;
    server = spawn('pnpm', ['dev'], {
      env: { ...process.env, TEGATA_DB: dbPath, PORT: String(port), HOST: '127.0.0.1' },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${base}/health`);
        if (r.ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not become ready');
  }, 60_000);

  afterAll(() => {
    server?.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async (path: string, body?: unknown, idem = `k-${Math.random()}`) => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'idempotency-key': idem,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    // The export is JSONL. Note that 'application/jsonl' contains 'application/json'
    // as a substring, so a naive check would try to parse a stream of documents as one.
    const contentType = res.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json') && !contentType.includes('jsonl');
    return { status: res.status, text, json: isJson ? JSON.parse(text) as Record<string, unknown> : {} };
  };

  it('runs the documented sequence end to end', async () => {
    const granted = await call('/v1/subjects/user_1/grants', { credits: 1000 });
    expect(granted.status).toBe(201);

    const issued = await call('/v1/authorizations', {
      subject_id: 'user_1', action: 'chat.completion',
      estimate: { provider: 'anthropic', model: 'claude-opus-5',
        input_tokens: 12_400, max_output_tokens: 2_000, cached_input_tokens: 8_000 },
    });
    expect(issued.status).toBe(201);
    expect(issued.json.decision).toBe('authorized');

    const captured = await call(`/v1/authorizations/${issued.json.authorization_id as string}/capture`, {
      actual: { input_tokens: 12_400, output_tokens: 1_180, cached_input_tokens: 8_000 },
    });
    expect(captured.status).toBe(200);
    expect(captured.json.state).toBe('captured');

    // The refusal the storyboard's second beat needs: same request, no balance.
    await call('/v1/subjects/broke/grants', { credits: 1 });
    const refused = await call('/v1/authorizations', {
      subject_id: 'broke', action: 'chat.completion',
      estimate: { provider: 'anthropic', model: 'claude-opus-5', input_tokens: 12_400, max_output_tokens: 2_000 },
    });
    expect(refused.status).toBe(200);
    expect(refused.json.decision).toBe('dishonored');
    expect(refused.json.reason).toBe('insufficient_balance');

    // The third beat: the export verifies without trusting the server that made it.
    const exported = await call('/v1/register/export');
    const report = verifyExport(exported.text);
    expect(report.ok).toBe(true);
    expect(report.manifestChecked).toBe(true);

    const tampered = exported.text.split('\n');
    const victim = JSON.parse(tampered[1]!) as Record<string, unknown>;
    victim.delta_amount = Number(victim.delta_amount) - 1;
    tampered[1] = JSON.stringify(victim);
    expect(verifyExport(tampered.join('\n')).ok).toBe(false);
  }, 60_000);

  it('keeps the README in step with the routes that exist', async () => {
    const readme = readFileSync('packages/server/README.md', 'utf8');
    // Each row of the endpoint table names a method and a path; probe exactly those.
    const rows = [...readme.matchAll(/^\| `(GET|POST|PUT)` \| `(\/v1\/[^`]+)`/gm)]
      .map((m) => ({ method: m[1] as string, path: m[2] as string }));
    expect(rows.length).toBeGreaterThan(8);

    for (const { method, path } of rows) {
      const probe = path.replace(':id', 'probe').replace(':action', 'probe').replace(':rule_id', 'probe');
      const res = await fetch(`${base}${probe}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`, 'content-type': 'application/json',
          'idempotency-key': `probe-${method}-${probe}`, 'tegata-tenant': 'probe',
        },
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
      // A documented route must exist. A handler answering 404 for a resource that is
      // not there is fine and carries our error shape; Fastify's route-miss does not.
      if (res.status === 404) {
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code, `${method} ${path} is not a route at all`).toBe('not_found');
      }
    }
  }, 30_000);
});
