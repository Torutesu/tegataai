import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  type Clock, type JsonObject, RateLimiter, TegataError, canonicalEmail,
  canonicalize, csvDocument, err, normaliseEmail, redactEmail, sha256Hex, toIso,
} from '@tegata/core';
import { Store, type TenantRow , stmt } from '@tegata/store';
import { validate } from './schemas.js';
import {
  capture, directUsage, expireMatured, issue, release, toEntryJson, type IssueResult,
} from './service.js';
import { marginReport } from './margin.js';
import { handleStripeEvent, verifyStripeSignature } from './stripe.js';

export interface AppOptions {
  store: Store;
  clock: Clock;
  logger?: boolean;
  /** PRD §12.6. Set either to 0 to disable that tier. */
  tenantRps?: number;
  subjectRps?: number;
  /** Origins allowed to submit the waitlist form. Empty means same-origin only. */
  waitlistOrigins?: string[];
  /** Signups per minute from one address. */
  waitlistRpm?: number;
}

declare module 'fastify' {
  interface FastifyRequest { tenant: TenantRow; }
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const { store } = opts;

  // PRD §12.6. Two tiers, because they answer different questions: the tenant limit
  // protects the node, the subject limit protects one tenant's users from each other.
  const tenantRps = opts.tenantRps ?? 1000;
  const subjectRps = opts.subjectRps ?? 20;
  const tenantLimiter = tenantRps > 0 ? new RateLimiter(opts.clock, tenantRps) : null;
  const subjectLimiter = subjectRps > 0 ? new RateLimiter(opts.clock, subjectRps) : null;

  // The waitlist is unauthenticated by necessity — it is a form on a public page — so it
  // gets its own limiter keyed by caller address, at a rate a person could not exceed.
  const waitlistRpm = opts.waitlistRpm ?? 5;
  const waitlistLimiter = waitlistRpm > 0
    ? new RateLimiter(opts.clock, 1, waitlistRpm) : null;
  const allowedOrigins = new Set(opts.waitlistOrigins ?? []);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_048_576 });

  // The waitlist form posts JSON as text/plain on purpose: it is a CORS-safelisted
  // content type, so the browser sends the request straight out instead of waiting for
  // a preflight to come back first. That round trip was the largest part of the time
  // between pressing the button and the confirmation appearing. Accepting the body here
  // is what makes it possible; nothing about how it is read changes.
  /**
   * A form with no script behind it posts like this. That happens whenever waitlist.js
   * does not run — script disabled, a blocked request, a host serving .js under a
   * content type that stops it being a module — and it used to end in a 500 with the
   * address dropped. The page is meant to degrade to a plain form post, so it has to be
   * a body the server reads.
   */
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    const text = body as string;
    if (text.length === 0) { done(null, {}); return; }
    try {
      done(null, JSON.parse(text) as unknown);
    } catch {
      done(err.validation('Body is not valid JSON'), undefined);
    }
  });


  /**
   * Nothing this API returns should be held anywhere. Balances, ledger entries and the
   * margin report are per-tenant and change under the caller; a proxy or a browser
   * cache that keeps one is showing someone a number that is no longer true, and
   * `private` is not enough because the caller is a server, not a person's browser.
   * `nosniff` is here for the same reason it is on the site: the response's own type is
   * the only type it should ever be treated as.
   */
  app.addHook('onSend', async (_req, reply) => {
    void reply.header('cache-control', 'no-store');
    void reply.header('x-content-type-options', 'nosniff');
  });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof TegataError) return reply.status(error.status).send(error.toJSON());
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 400) return reply.status(400).send(err.validation(String((error as Error).message)).toJSON());
    app.log.error(error);
    return reply.status(500).send(
      new TegataError('internal', 500, 'Internal error').toJSON(),
    );
  });

  /** Every route but the Stripe webhook is tenant-authenticated. */
  const authenticate = (req: FastifyRequest): TenantRow => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) throw err.unauthorized();
    const tenant = store.tenantByKey(header.slice(7));
    if (tenant === undefined) throw err.unauthorized();
    return tenant;
  };

  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/v1/webhooks/') || req.url.startsWith('/v1/waitlist')
      || req.url === '/health') return;
    req.tenant = authenticate(req);

    // The tenant tier is about protecting the node, so it answers at the transport
    // level. The subject tier is about one account's own budget, so it answers as a
    // dishonor further down — a business outcome, not a transport failure.
    if (tenantLimiter !== null) {
      const d = tenantLimiter.take(req.tenant.tenant_id);
      if (!d.allowed) {
        void reply.header('retry-after', String(d.retryAfterSeconds));
        throw new TegataError('rate_limited', 429,
          'Too many requests for this tenant', { retry_after: d.retryAfterSeconds });
      }
    }
  });

  /**
   * Claim the idempotency key before the work and store the response after, so a
   * replay returns the original bytes rather than recomputing (spec §8).
   */
  const idempotent = async <T>(
    req: FastifyRequest, reply: FastifyReply, run: () => { status: number; body: T },
  ): Promise<unknown> => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) throw err.idempotencyRequired();
    const tenantId = req.tenant.tenant_id;
    const requestHash = sha256Hex(`${req.url}\n${canonicalize((req.body ?? {}) as never)}`);

    const existing = store.lookupIdempotent(tenantId, key, requestHash);
    if (existing === 'conflict') throw err.idempotencyReuse(key);
    if (existing !== undefined) {
      if (existing.status === 0) throw err.validation('A request with this idempotency key is still in flight', { key });
      return reply.status(existing.status).send(existing.body);
    }
    if (!store.claimIdempotent(tenantId, key, requestHash)) {
      const raced = store.lookupIdempotent(tenantId, key, requestHash);
      if (raced === 'conflict') throw err.idempotencyReuse(key);
      if (raced !== undefined && raced.status !== 0) return reply.status(raced.status).send(raced.body);
      throw err.validation('A request with this idempotency key is still in flight', { key });
    }
    try {
      const { status, body } = run();
      store.completeIdempotent(tenantId, key, status, body);
      return reply.status(status).send(body);
    } catch (e) {
      store.releaseIdempotent(tenantId, key);
      throw e;
    }
  };

  app.get('/health', async () => ({ status: 'ok' }));

  // ------------------------------------------------------------------ waitlist

  /**
   * A public form, so this route is unauthenticated and everything it accepts is
   * treated as hostile. It answers identically whether an address is new, already
   * present, or malformed — anything else would make it a tool for checking who has
   * signed up, and the reply is read by a stranger's browser.
   */
  const corsFor = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string') return true;          // same-origin or a non-browser client
    if (!allowedOrigins.has(origin)) return false;
    void reply.header('access-control-allow-origin', origin);
    void reply.header('vary', 'Origin');
    return true;
  };

  app.options('/v1/waitlist', async (req, reply) => {
    if (!corsFor(req, reply)) return reply.status(403).send();
    void reply.header('access-control-allow-methods', 'POST, OPTIONS');
    void reply.header('access-control-allow-headers', 'content-type');
    void reply.header('access-control-max-age', '86400');
    return reply.status(204).send();
  });

  app.post('/v1/waitlist', async (req, reply) => {
    if (!corsFor(req, reply)) return reply.status(403).send({ error: { code: 'forbidden_origin' } });

    /**
     * A form post lands the person on this response, so it answers in a sentence rather
     * than in JSON. Everything else about the route is identical — this decides how the
     * answer reads, never what it says.
     */
    const posted_by_a_form = (req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded');
    const accepted = (): FastifyReply => (posted_by_a_form
      ? reply.status(202).type('text/plain; charset=utf-8')
        .send('You are on the list. We will write when there is something to try.\n')
      : reply.status(202).send({ ok: true }));

    const body = (req.body ?? {}) as Record<string, unknown>;
    // A field no person fills in. Bots fill in everything.
    if (typeof body.company_website === 'string' && body.company_website.length > 0) {
      return accepted();
    }

    const caller = (req.headers['cf-connecting-ip'] as string | undefined)
      ?? (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      ?? req.ip;
    if (waitlistLimiter !== null) {
      const d = waitlistLimiter.take(`wl:${caller}`);
      if (!d.allowed) {
        void reply.header('retry-after', String(d.retryAfterSeconds));
        return reply.status(429).send({ error: { code: 'rate_limited' } });
      }
    }

    const raw = typeof body.email === 'string' ? body.email : '';
    const check = normaliseEmail(raw);
    if (!check.ok) {
      // The one case where saying what is wrong helps the person rather than a prober:
      // they typed their own address and can see it on screen.
      if (posted_by_a_form) {
        return reply.status(400).type('text/plain; charset=utf-8')
          .send('That address did not look right. Go back and check it?\n');
      }
      return reply.status(400).send({ error: { code: 'invalid_email', reason: check.reason } });
    }

    /**
     * These two are ours, not the submitter's — the page fills them in and nobody types
     * them. Accepting arbitrary text there would put a stranger's string into the export
     * the owner opens, so anything that is not the shape we write is discarded rather
     * than trimmed: a tag we did not write tells us nothing anyway.
     */
    const tidy = (v: unknown, pattern: RegExp, max: number): string | null => {
      if (typeof v !== 'string') return null;
      const trimmed = v.trim().slice(0, max);
      return pattern.test(trimmed) ? trimmed : null;
    };
    const locale = tidy(body.locale, /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})*$/, 16);
    const source = tidy(body.source, /^[a-z0-9][a-z0-9._-]*$/, 32) ?? 'site';
    store.addToWaitlist({
      emailHash: sha256Hex(canonicalEmail(check.normalised)),
      email: check.normalised,
      source, locale, note: null,
    });
    req.log?.info({ waitlist: redactEmail(check.normalised), source }, 'waitlist signup');
    // Always the same answer, whether or not this address was already known.
    return accepted();
  });

  app.get('/v1/waitlist/export', async (req, reply) => {
    req.tenant = authenticate(req);
    const rows = store.waitlistEntries();
    // csvDocument, not string concatenation: this file is opened in a spreadsheet by the
    // one person holding the export key, and two of its columns arrive from a public
    // form. A cell that starts a formula would run as them.
    const csv = csvDocument(
      ['id', 'email', 'source', 'locale', 'created_at'],
      rows.map((r) => [r.id, r.email, r.source, r.locale ?? '', r.created_at]),
    );
    void reply.header('content-type', 'text/csv; charset=utf-8');
    void reply.header('content-disposition', 'attachment; filename="waitlist.csv"');
    return csv;
  });

  app.get('/v1/waitlist/count', async (req) => {
    req.tenant = authenticate(req);
    return { count: store.waitlistCount() };
  });

  // ------------------------------------------------------------ authorizations

  app.post('/v1/authorizations', async (req, reply) => {
    validate('issue', req.body);
    const subjectId = (req.body as { subject_id: string }).subject_id;
    if (subjectLimiter !== null) {
      const d = subjectLimiter.take(`${req.tenant.tenant_id}:${subjectId}`);
      if (!d.allowed) {
        // A refused request is still a decision the caller has to act on, so it comes
        // back the same shape as any other refusal (spec/authorization.md §4.1).
        void reply.header('tegata-decision', 'dishonored');
        void reply.header('retry-after', String(d.retryAfterSeconds));
        return reply.status(200).send({
          decision: 'dishonored', reason: 'rate_limited',
          available: store.balances(req.tenant.tenant_id, subjectId).available,
          required: 0, retry_after: d.retryAfterSeconds,
        });
      }
    }
    return idempotent<IssueResult>(req, reply, () => {
      const result = issue(store, req.tenant.tenant_id, req.body as never, req.tenant);
      if (result.decision === 'dishonored') {
        // A refusal is a correct answer, not a transport failure: 200 with a decision,
        // plus a header so proxies and logs can tell the two apart (spec §4.1).
        void reply.header('tegata-decision', 'dishonored');
        return { status: 200, body: result };
      }
      void reply.header('tegata-decision', 'authorized');
      return { status: 201, body: result };
    });
  });

  app.post<{ Params: { id: string } }>('/v1/authorizations/:id/capture', async (req, reply) => {
    validate('capture', req.body ?? {});
    return idempotent(req, reply, () => ({
      status: 200, body: capture(store, req.tenant.tenant_id, req.params.id, (req.body ?? {}) as never),
    }));
  });

  app.post<{ Params: { id: string } }>('/v1/authorizations/:id/release', async (req, reply) => {
    validate('release', req.body ?? {});
    const reason = (req.body as { reason?: string } | undefined)?.reason;
    return idempotent(req, reply, () => ({
      status: 200, body: release(store, req.tenant.tenant_id, req.params.id, reason),
    }));
  });

  app.get<{ Params: { id: string } }>('/v1/authorizations/:id', async (req) => {
    const row = store.getAuthorization(req.tenant.tenant_id, req.params.id);
    if (row === undefined) throw err.notFound('Authorization', req.params.id);
    return {
      authorization_id: row.authorization_id, subject_id: row.subject_id, action: row.action,
      state: row.state, face_value: row.face_value, maturity: row.maturity,
      captured_amount: row.captured_amount, cost_micro_usd: row.cost_micro_usd,
      dishonor_reason: row.dishonor_reason, provisional: row.provisional === 1,
    };
  });

  app.post('/v1/usage', async (req, reply) => {
    validate('usage', req.body);
    return idempotent(req, reply, () => ({
      status: 200, body: directUsage(store, req.tenant.tenant_id, req.body as never),
    }));
  });

  // ------------------------------------------------------------------ subjects

  app.get<{ Params: { id: string } }>('/v1/subjects/:id', async (req) => {
    const tenantId = req.tenant.tenant_id;
    const subject = store.getSubject(tenantId, req.params.id);
    if (subject === undefined) throw err.notFound('Subject', req.params.id);
    return {
      subject_id: subject.subject_id, status: subject.status,
      ...store.balances(tenantId, req.params.id),
      entitlements: store.activeEntitlements(tenantId, req.params.id).map((e) => ({
        entitlement_id: e.entitlement_id, source: e.source,
        credits_granted: e.credits_granted, credits_remaining: e.credits_remaining,
        expires_at: e.expires_at, priority: e.priority,
      })),
    };
  });

  app.put<{ Params: { id: string } }>('/v1/subjects/:id/status', async (req) => {
    validate('subjectStatus', req.body);
    const { status } = req.body as { status: 'active' | 'suspended' | 'deleted' };
    store.ensureSubject(req.tenant.tenant_id, req.params.id);
    store.setSubjectStatus(req.tenant.tenant_id, req.params.id, status);
    return { subject_id: req.params.id, status };
  });

  app.post<{ Params: { id: string } }>('/v1/subjects/:id/grants', async (req, reply) => {
    validate('grant', req.body);
    return idempotent(req, reply, () => {
      const b = req.body as { credits: number; source?: 'grant' | 'promo' | 'topup'; expires_at?: string; priority?: number; amount_micro_usd?: number };
      const tenantId = req.tenant.tenant_id;
      const out = store.withSubject(() => {
        store.ensureSubject(tenantId, req.params.id);
        const { entitlement } = store.grant(tenantId, req.params.id, {
          source: b.source ?? 'grant', credits: b.credits,
          expires_at: b.expires_at ?? null, priority: b.priority ?? 100,
          amount_micro_usd: b.amount_micro_usd ?? 0,
        });
        if ((b.amount_micro_usd ?? 0) > 0) {
          // Top-ups are recognised as they are consumed; the export cannot show
          // consumption, so we straight-line over 30 days as the tool does (PRD §11.2).
          const start = store.now();
          store.recordRevenue(tenantId, req.params.id, 'topup', b.amount_micro_usd as number,
            start, toIso(store.nowMs() + 30 * 86_400_000), null);
        }
        return entitlement;
      });
      return {
        status: 201,
        body: {
          entitlement_id: out.entitlement_id, credits_granted: out.credits_granted,
          credits_remaining: out.credits_remaining, ...store.balances(req.tenant.tenant_id, req.params.id),
        },
      };
    });
  });

  app.get<{ Params: { id: string }; Querystring: { after_seq?: string; limit?: string } }>(
    '/v1/subjects/:id/register', async (req, reply) => {
      const entries = store.registerEntries(
        req.tenant.tenant_id, req.params.id,
        Number(req.query.after_seq ?? 0), Number(req.query.limit ?? 10_000),
      );
      void reply.header('content-type', 'application/jsonl');
      return entries.map((e) => JSON.stringify(toEntryJson(e))).join('\n') + (entries.length > 0 ? '\n' : '');
    });

  // ------------------------------------------------------------------- export

  app.get('/v1/register/export', async (req, reply) => {
    const tenantId = req.tenant.tenant_id;
    const subjects = store.listSubjects(tenantId);
    const lines: string[] = [];
    let count = 0;
    let earliest: string | null = null;
    let latest: string | null = null;
    const heads: JsonObject[] = [];
    for (const s of subjects) {
      const entries = store.registerEntries(tenantId, s.subject_id);
      for (const e of entries) {
        lines.push(JSON.stringify(toEntryJson(e)));
        count++;
        if (earliest === null || e.at < earliest) earliest = e.at;
        if (latest === null || e.at > latest) latest = e.at;
      }
      const head = entries[entries.length - 1];
      if (head !== undefined) heads.push({ subject_id: s.subject_id, seq: head.seq, hash: head.hash });
    }
    lines.push(JSON.stringify({
      manifest: true, subjects: subjects.length, entries: count,
      range: [earliest, latest], roots: heads,
    }));
    void reply.header('content-type', 'application/jsonl');
    void reply.header('content-disposition', 'attachment; filename="tegata-register.jsonl"');
    return lines.join('\n') + '\n';
  });

  // ------------------------------------------------------------------ metrics

  app.get<{ Querystring: { window_days?: string } }>('/v1/metrics/margin', async (req) => {
    const days = Number(req.query.window_days ?? 30);
    if (!Number.isSafeInteger(days) || days <= 0) throw err.validation('window_days must be a positive integer');
    return marginReport(store, req.tenant.tenant_id, days);
  });

  // ------------------------------------------------------------ configuration

  app.put<{ Params: { action: string } }>('/v1/actions/:action', async (req) => {
    validate('action', req.body);
    const b = req.body as Record<string, unknown>;
    store.upsertAction(req.tenant.tenant_id, {
      action: req.params.action,
      pricing_mode: b.pricing_mode as 'token_based',
      fixed_credits: (b.fixed_credits as number | undefined) ?? null,
      default_face_value: b.default_face_value as number,
      min_face_value: (b.min_face_value as number | undefined) ?? 1,
      fallback_action: (b.fallback_action as string | null | undefined) ?? null,
      fallback_model: (b.fallback_model as string | null | undefined) ?? null,
      markup_milli: (b.markup_milli as number | undefined) ?? 1000,
    });
    return { action: req.params.action, ...store.getAction(req.tenant.tenant_id, req.params.action) };
  });

  app.put('/v1/cost-table', async (req) => {
    validate('costTable', req.body);
    const b = req.body as { version: string; effective_from?: string; rates: Record<string, unknown>[] };
    if (store.costTableVersionExists(b.version)) throw err.costTableExists(b.version);
    store.insertCostRates(b.version, b.effective_from ?? store.now(), b.rates.map((r) => ({
      provider: r.provider as string, model: r.model as string, unit: (r.unit as string) ?? 'token',
      input_micro_usd_per_unit: (r.input_micro_usd_per_unit as number) ?? 0,
      output_micro_usd_per_unit: (r.output_micro_usd_per_unit as number) ?? 0,
      cached_input_micro_usd_per_unit: (r.cached_input_micro_usd_per_unit as number) ?? 0,
    })));
    return { version: b.version, rates: b.rates.length };
  });

  app.put<{ Params: { rule_id: string } }>('/v1/rules/:rule_id', async (req) => {
    validate('rule', req.body);
    const b = req.body as Record<string, unknown>;
    stmt(store.db, 
      `INSERT INTO intervention_rule (tenant_id,rule_id,on_event,when_expr,cooldown_hours,holdout_pct,action,enabled)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id,rule_id) DO UPDATE SET on_event=excluded.on_event,
         when_expr=excluded.when_expr, cooldown_hours=excluded.cooldown_hours,
         holdout_pct=excluded.holdout_pct, action=excluded.action, enabled=excluded.enabled`,
    ).run(
      req.tenant.tenant_id, req.params.rule_id, b.on as string,
      JSON.stringify(b.when ?? {}), (b.cooldown_hours as number | undefined) ?? 72,
      (b.holdout_pct as number | undefined) ?? 10, JSON.stringify(b.action),
      b.enabled === false ? 0 : 1,
    );
    return { rule_id: req.params.rule_id, on: b.on };
  });

  app.get('/v1/rules', async (req) => ({
    rules: stmt(store.db, 'SELECT rule_id,on_event,cooldown_hours,holdout_pct,enabled FROM intervention_rule WHERE tenant_id = ?')
      .all(req.tenant.tenant_id),
  }));

  app.get<{ Params: { rule_id: string } }>('/v1/rules/:rule_id/firings', async (req) => ({
    firings: stmt(store.db, 
      'SELECT subject_id,fired_at,holdout FROM rule_firing WHERE tenant_id = ? AND rule_id = ? ORDER BY fired_at',
    ).all(req.tenant.tenant_id, req.params.rule_id),
  }));

  // ------------------------------------------------------------------- stripe

  // ------------------------------------------------------------- housekeeping

  app.post('/v1/admin/sweep', async (req) => {
    const expired = expireMatured(store);
    const purged = store.purgeIdempotency(toIso(store.nowMs() - 86_400_000));
    const entitlements = sweepEntitlements(store, req.tenant.tenant_id);
    return { authorizations_expired: expired, idempotency_purged: purged, entitlements_expired: entitlements };
  });

  /**
   * The webhook lives in its own plugin so the raw-body parser it needs is scoped to it.
   * Keeping the bytes costs a string conversion on every request it applies to, and
   * paying that on every route to serve one route measured at about a third of the
   * service's throughput — so the cost stays where the requirement is.
   */
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
      if ((body as string).length === 0) { done(null, {}); return; }
      try {
        done(null, JSON.parse(body as string) as unknown);
      } catch {
        done(err.validation('Body is not valid JSON'), undefined);
      }
    });

    registerStripeWebhook(scope, store);
  });

  return app;
}

/**
 * This endpoint mints credits, so it authenticates before it does anything else.
   * An unknown tenant, a tenant with no configured secret, and a missing signature are
   * all 401 — there is no path through here that trusts the caller. It answers the same
   * way for an unknown tenant as for a missing signature, so it cannot be used to
   * enumerate which tenant ids exist.
   */
function registerStripeWebhook(app: FastifyInstance, store: Store): void {
  app.post('/v1/webhooks/stripe', async (req, reply) => {
    const tenantId = (req.headers['tegata-tenant'] ?? '') as string;
    const tenant = store.getTenant(tenantId);
    const secret = tenant?.webhook_secret ?? null;
    const sig = req.headers['stripe-signature'];
    if (tenant === undefined || secret === null || typeof sig !== 'string') {
      throw err.unauthorized();
    }
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    verifyStripeSignature(raw, sig, secret, store.nowMs());

    const result = handleStripeEvent(store, tenantId, (req.body ?? {}) as JsonObject);
    return reply.status(200).send(result);
  });
}


/** Grants past their expiry lapse, and the unused remainder leaves the balance. */
export function sweepEntitlements(store: Store, tenantId: string): number {
  let n = 0;
  for (const subject of store.listSubjects(tenantId)) {
    store.withSubject(() => {
      for (const ent of store.activeEntitlements(tenantId, subject.subject_id)) {
        if (ent.expires_at === null || ent.expires_at > store.now()) continue;
        store.expireEntitlement(tenantId, subject.subject_id, ent, 'entitlement_expired');
        n++;
      }
    });
  }
  return n;
}
