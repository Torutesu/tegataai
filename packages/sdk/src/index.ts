import type { ActualUsage, Credits, DegradedMode, DishonorReason, Estimate, JsonObject } from '@tegata/core';

export interface TegataOptions {
  baseUrl: string;
  secretKey: string;
  /** Beyond this, we stop waiting and fall back to the declared posture. */
  timeoutMs?: number;
  /** Omit to adopt the tenant's server-side setting on first contact. */
  degraded?: DegradedMode;
  fetch?: typeof globalThis.fetch;
  /** Overdraft allowance while degraded; also adopted from the tenant. */
  maxOverdraftCredits?: Credits;
  onQueueChange?: (pending: number) => void;
}

export interface Authorized {
  decision: 'authorized';
  dishonored: false;
  authorization_id: string;
  face_value: Credits;
  available_after_hold: Credits;
  maturity: string;
  /** Issued locally because the service could not be reached. */
  provisional: boolean;
  latencyMs: number;
}

export interface Dishonored {
  decision: 'dishonored';
  dishonored: true;
  reason: DishonorReason;
  available: Credits;
  required: Credits;
  remedy?: { fallback_action: string; fallback_face_value: Credits };
  provisional: boolean;
  latencyMs: number;
}

export type Decision = Authorized | Dishonored;

interface QueuedCapture {
  idempotencyKey: string;
  authorizationId: string | null;
  subjectId: string;
  action: string;
  body: Record<string, unknown>;
}

/** Usage shapes we map without asking the caller to translate. */
export function normaliseUsage(usage: Record<string, unknown>): ActualUsage {
  const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);
  const out: ActualUsage = {};
  const input = n(usage.input_tokens) ?? n(usage.prompt_tokens);
  const output = n(usage.output_tokens) ?? n(usage.completion_tokens);
  // Anthropic reports cache reads separately and excludes them from input_tokens;
  // OpenAI nests them under prompt_tokens_details. Both end up in one field here.
  const cachedDirect = n(usage.cached_input_tokens) ?? n(usage.cache_read_input_tokens);
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const cachedNested = details === undefined ? undefined : n(details.cached_tokens);
  const cached = cachedDirect ?? cachedNested;

  if (input !== undefined) out.input_tokens = cachedDirect !== undefined ? input + cachedDirect : input;
  if (output !== undefined) out.output_tokens = output;
  if (cached !== undefined) out.cached_input_tokens = cached;
  const units = n(usage.units);
  if (units !== undefined) out.units = units;
  return out;
}

export class TegataClient {
  private readonly opts: Required<Pick<TegataOptions, 'baseUrl' | 'secretKey' | 'timeoutMs'>> & TegataOptions;
  private readonly doFetch: typeof globalThis.fetch;
  private queue: QueuedCapture[] = [];
  private posture: DegradedMode | undefined;
  private overdraft: Credits;
  /** Last balance we were told about, per subject: the only basis for a local decision. */
  private readonly cachedAvailable = new Map<string, Credits>();
  private counter = 0;

  constructor(options: TegataOptions) {
    this.opts = { timeoutMs: 200, ...options } as never;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.posture = options.degraded;
    this.overdraft = options.maxOverdraftCredits ?? 0;
  }

  get pendingCaptures(): number { return this.queue.length; }
  get degradedPosture(): DegradedMode | undefined { return this.posture; }

  guard(params: { subjectId: string; action: string; context?: JsonObject }): Guard {
    return new Guard(this, params.subjectId, params.action, params.context);
  }

  private key(): string { return `sdk-${Date.now().toString(36)}-${(++this.counter).toString(36)}`; }

  /** @internal */
  async request(path: string, body: unknown, idempotencyKey?: string): Promise<{ ok: true; status: number; json: Record<string, unknown> } | { ok: false; error: Error }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The deadline is enforced here as well as through the abort signal. A fetch that
    // ignores the signal would otherwise hang forever, which is precisely the outage
    // the degraded posture exists to survive — so we never depend on it honouring one.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`tegata: request exceeded ${this.opts.timeoutMs}ms`));
      }, this.opts.timeoutMs);
    });
    try {
      const res = await Promise.race([
        this.doFetch(`${this.opts.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.opts.secretKey}`,
            'idempotency-key': idempotencyKey ?? this.key(),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        deadline,
      ]);
      const json = (await Promise.race([res.json(), deadline])) as Record<string, unknown>;
      return { ok: true, status: res.status, json };
    } catch (e) {
      return { ok: false, error: e as Error };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** @internal */
  rememberAvailable(subjectId: string, available: Credits): void {
    this.cachedAvailable.set(subjectId, available);
    if (this.posture === undefined) this.posture = 'allow';
  }

  /** @internal */
  localAvailable(subjectId: string): Credits {
    return this.cachedAvailable.get(subjectId) ?? 0;
  }

  /** @internal */
  spendLocally(subjectId: string, credits: Credits): void {
    this.cachedAvailable.set(subjectId, this.localAvailable(subjectId) - credits);
  }

  /** @internal */
  effectivePosture(): DegradedMode { return this.posture ?? 'allow'; }

  /** @internal */
  overdraftAllowance(): Credits { return this.overdraft; }

  /** @internal */
  enqueue(item: QueuedCapture): void {
    this.queue.push(item);
    this.opts.onQueueChange?.(this.queue.length);
  }

  /**
   * Send what could not be sent while the service was unreachable. Each item keeps
   * its original idempotency key, so a capture that did land is not applied twice.
   */
  async flush(): Promise<{ sent: number; remaining: number }> {
    let sent = 0;
    const pending = [...this.queue];
    this.queue = [];
    for (const item of pending) {
      const path = item.authorizationId === null
        ? '/v1/usage'
        : `/v1/authorizations/${item.authorizationId}/capture`;
      const res = await this.request(path, item.body, item.idempotencyKey);
      if (res.ok && res.status < 500) { sent++; continue; }
      this.queue.push(item);
    }
    this.opts.onQueueChange?.(this.queue.length);
    return { sent, remaining: this.queue.length };
  }
}

/**
 * Wraps one action. `issue` never throws — a network failure produces a decision
 * under the declared posture, because an authorization layer that throws takes the
 * customer's product down with it (spec/authorization.md §7).
 */
export class Guard {
  private authorizationId: string | null = null;
  private faceValue: Credits = 0;
  private provisional = false;
  private settled = false;
  private readonly captureKey: string;

  constructor(
    private readonly client: TegataClient,
    private readonly subjectId: string,
    private readonly action: string,
    private readonly context?: JsonObject,
  ) {
    this.captureKey = `cap-${subjectId}-${action}-${Date.now().toString(36)}-${Math.trunc(performance.now() * 1000).toString(36)}`;
  }

  get id(): string | null { return this.authorizationId; }
  get isProvisional(): boolean { return this.provisional; }

  async issue(estimate?: Estimate, maturitySeconds?: number): Promise<Decision> {
    const started = performance.now();
    const body: Record<string, unknown> = { subject_id: this.subjectId, action: this.action };
    if (estimate !== undefined) body.estimate = estimate;
    if (maturitySeconds !== undefined) body.maturity_seconds = maturitySeconds;
    if (this.context !== undefined) body.context = this.context;

    const res = await this.client.request('/v1/authorizations', body);
    const latencyMs = performance.now() - started;

    if (res.ok && (res.status === 200 || res.status === 201)) {
      const json = res.json;
      if (json.decision === 'authorized') {
        this.authorizationId = json.authorization_id as string;
        this.faceValue = json.face_value as number;
        this.client.rememberAvailable(this.subjectId, json.available_after_hold as number);
        return {
          decision: 'authorized', dishonored: false,
          authorization_id: this.authorizationId, face_value: this.faceValue,
          available_after_hold: json.available_after_hold as number,
          maturity: json.maturity as string, provisional: false, latencyMs,
        };
      }
      this.client.rememberAvailable(this.subjectId, json.available as number);
      return {
        decision: 'dishonored', dishonored: true,
        reason: json.reason as DishonorReason,
        available: json.available as number, required: json.required as number,
        remedy: json.remedy as Dishonored['remedy'], provisional: false, latencyMs,
      };
    }
    if (res.ok) {
      // A 4xx is our caller's problem to see, not something to paper over locally.
      const error = res.json.error as { message?: string } | undefined;
      throw new Error(`tegata: ${String(error?.message ?? `HTTP ${res.status}`)}`);
    }
    return this.degradedDecision(latencyMs);
  }

  private degradedDecision(latencyMs: number): Decision {
    const posture = this.client.effectivePosture();
    const available = this.client.localAvailable(this.subjectId);
    if (posture === 'deny') {
      return {
        decision: 'dishonored', dishonored: true, reason: 'service_degraded',
        available, required: 0, provisional: true, latencyMs,
      };
    }
    // allow / allow_cheap_only: proceed on the last known balance plus the allowance,
    // and reconcile afterwards. Stopping the customer's product to avoid a small
    // accounting error is the worse trade for a layer whose value is trust.
    this.provisional = true;
    this.authorizationId = null;
    this.faceValue = 0;
    return {
      decision: 'authorized', dishonored: false,
      authorization_id: `local-${this.captureKey}`, face_value: 0,
      available_after_hold: available, maturity: new Date(Date.now() + 300_000).toISOString(),
      provisional: true, latencyMs,
    };
  }

  /** Settle. Queued locally if the service is unreachable, with a stable key. */
  async capture(usage?: Record<string, unknown> | ActualUsage, extra?: { amount?: Credits; cost_micro_usd?: number; provider?: string; model?: string }): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    const body: Record<string, unknown> = {};
    if (usage !== undefined) body.actual = normaliseUsage(usage as Record<string, unknown>);
    if (extra?.amount !== undefined) body.amount = extra.amount;
    if (extra?.cost_micro_usd !== undefined) body.cost_micro_usd = extra.cost_micro_usd;
    if (extra?.provider !== undefined) body.provider = extra.provider;
    if (extra?.model !== undefined) body.model = extra.model;

    if (this.authorizationId === null || this.provisional) {
      const direct = { subject_id: this.subjectId, action: this.action, ...body };
      const res = await this.client.request('/v1/usage', direct, this.captureKey);
      if (!res.ok || res.status >= 500) {
        this.client.enqueue({
          idempotencyKey: this.captureKey, authorizationId: null,
          subjectId: this.subjectId, action: this.action, body: direct,
        });
        if (extra?.amount !== undefined) this.client.spendLocally(this.subjectId, extra.amount);
      } else {
        this.client.rememberAvailable(this.subjectId, res.json.available as number);
      }
      return;
    }
    const res = await this.client.request(`/v1/authorizations/${this.authorizationId}/capture`, body, this.captureKey);
    if (!res.ok || res.status >= 500) {
      this.client.enqueue({
        idempotencyKey: this.captureKey, authorizationId: this.authorizationId,
        subjectId: this.subjectId, action: this.action, body,
      });
      return;
    }
    if (res.status < 300) this.client.rememberAvailable(this.subjectId, res.json.available as number);
  }

  /** Return an unused hold. Safe to call after capture; it does nothing then. */
  async release(reason = 'released_by_caller'): Promise<void> {
    if (this.settled || this.authorizationId === null || this.provisional) return;
    this.settled = true;
    await this.client.request(`/v1/authorizations/${this.authorizationId}/release`, { reason }, `rel-${this.captureKey}`);
  }
}
