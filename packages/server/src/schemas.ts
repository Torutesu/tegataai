import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err } from '@tegata/core';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Request schemas are defined here; object schemas are loaded from spec/schema and
 * never restated (CLAUDE.md rule 6). A published schema that the implementation
 * quietly diverges from is worse than no published schema.
 */
const ajv = new Ajv2020({ allErrors: true, strict: false, coerceTypes: false });
addFormats(ajv);

export const specSchema = (name: string): object =>
  JSON.parse(readFileSync(join(repoRoot, 'spec', 'schema', name), 'utf8')) as object;

export const registerEntryValidator = ajv.compile(specSchema('register-entry.schema.json'));

const integer = { type: 'integer' } as const;
const nonNegative = { type: 'integer', minimum: 0 } as const;

const estimateSchema = {
  type: 'object',
  required: ['provider', 'model'],
  additionalProperties: false,
  properties: {
    provider: { type: 'string', minLength: 1, maxLength: 64 },
    model: { type: 'string', minLength: 1, maxLength: 128 },
    input_tokens: nonNegative,
    max_output_tokens: nonNegative,
    cached_input_tokens: nonNegative,
    units: nonNegative,
  },
} as const;

const actualSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    input_tokens: nonNegative,
    output_tokens: nonNegative,
    cached_input_tokens: nonNegative,
    units: nonNegative,
  },
} as const;

export const schemas = {
  issue: {
    type: 'object',
    required: ['subject_id', 'action'],
    additionalProperties: false,
    properties: {
      subject_id: { type: 'string', minLength: 1, maxLength: 256 },
      action: { type: 'string', minLength: 1, maxLength: 128 },
      estimate: estimateSchema,
      maturity_seconds: { type: 'integer', minimum: 1, maximum: 3600 },
      context: { type: 'object' },
      provisional: { type: 'boolean' },
    },
  },
  capture: {
    type: 'object',
    additionalProperties: false,
    properties: {
      actual: actualSchema,
      amount: nonNegative,
      cost_micro_usd: nonNegative,
      provider: { type: 'string' },
      model: { type: 'string' },
    },
  },
  release: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', maxLength: 128 } } },
  usage: {
    type: 'object',
    required: ['subject_id', 'action'],
    additionalProperties: false,
    properties: {
      subject_id: { type: 'string', minLength: 1, maxLength: 256 },
      action: { type: 'string', minLength: 1, maxLength: 128 },
      actual: actualSchema,
      amount: nonNegative,
      cost_micro_usd: nonNegative,
      provider: { type: 'string' },
      model: { type: 'string' },
      context: { type: 'object' },
    },
  },
  grant: {
    type: 'object',
    required: ['credits'],
    additionalProperties: false,
    properties: {
      credits: { type: 'integer', minimum: 1 },
      source: { enum: ['grant', 'promo', 'topup'] },
      expires_at: { type: 'string', format: 'date-time' },
      priority: integer,
      amount_micro_usd: nonNegative,
      refresh_policy: { enum: ['reset', 'rollover', 'rollover_capped'] },
      rollover_cap_credits: nonNegative,
    },
  },
  action: {
    type: 'object',
    required: ['pricing_mode', 'default_face_value'],
    additionalProperties: false,
    properties: {
      pricing_mode: { enum: ['token_based', 'fixed', 'unit_based'] },
      fixed_credits: nonNegative,
      default_face_value: nonNegative,
      min_face_value: nonNegative,
      fallback_action: { type: ['string', 'null'], maxLength: 128 },
      fallback_model: { type: ['string', 'null'], maxLength: 128 },
      markup_milli: { type: 'integer', minimum: 1 },
    },
  },
  costTable: {
    type: 'object',
    required: ['version', 'rates'],
    additionalProperties: false,
    properties: {
      version: { type: 'string', minLength: 1, maxLength: 64 },
      effective_from: { type: 'string', format: 'date-time' },
      rates: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['provider', 'model'],
          additionalProperties: false,
          properties: {
            provider: { type: 'string' },
            model: { type: 'string' },
            unit: { enum: ['token', 'image', 'second', 'request'] },
            input_micro_usd_per_unit: nonNegative,
            output_micro_usd_per_unit: nonNegative,
            cached_input_micro_usd_per_unit: nonNegative,
          },
        },
      },
    },
  },
  rule: {
    type: 'object',
    required: ['on', 'action'],
    additionalProperties: false,
    properties: {
      on: { type: 'string', minLength: 1, maxLength: 64 },
      when: { type: 'object' },
      cooldown_hours: nonNegative,
      holdout_pct: { type: 'integer', minimum: 0, maximum: 50 },
      action: {
        type: 'object',
        required: ['type'],
        properties: { type: { enum: ['webhook'] } },
      },
      enabled: { type: 'boolean' },
    },
  },
  subjectStatus: {
    type: 'object',
    required: ['status'],
    additionalProperties: false,
    properties: { status: { enum: ['active', 'suspended', 'deleted'] } },
  },
} as const;

const compiled = new Map<string, ValidateFunction>();

export function validate(name: keyof typeof schemas, body: unknown): void {
  let v = compiled.get(name);
  if (v === undefined) {
    v = ajv.compile(schemas[name]);
    compiled.set(name, v);
  }
  if (v(body)) return;
  const details = (v.errors ?? []).map((e) => ({
    path: e.instancePath === '' ? '/' : e.instancePath,
    message: e.message ?? 'invalid',
  }));
  throw err.validation('Request body does not match the schema', { errors: details });
}

/** Every register entry we emit must satisfy the published schema (INV-11). */
export function assertRegisterEntry(entry: unknown): void {
  if (registerEntryValidator(entry)) return;
  const errors = (registerEntryValidator.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
  throw new Error(`register entry violates spec/schema/register-entry.schema.json: ${errors.join('; ')}`);
}
