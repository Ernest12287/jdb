/**
 * Zero-dependency JSON-Schema-subset validator.
 *
 * It understands the subset of JSON Schema emitted by @sinclair/typebox
 * (type, properties, required, additionalProperties, enum/const/literal,
 * minimum/maximum, exclusiveMinimum/exclusiveMaximum, multipleOf,
 * minLength/maxLength, pattern, format:date-time, items, uniqueItems,
 * minItems/maxItems, anyOf/oneOf/allOf, unionSchemas, not).
 *
 * Any TypeBox schema is therefore validated at runtime, and
 * `Static<typeof Schema>` gives compile-time types.
 */

import type { TSchemaLike, ValidationErrorDetail } from './types.js';

type Validator = (value: unknown) => boolean;

const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?(([Zz])|([+-]\d{2}:?\d{2}))?$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function matchType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isObject(value);
    case 'null':
      return value === null;
    case 'any':
    case 'unknown':
      return true;
    default:
      return false;
  }
}

/** Compile a JSON-schema-ish node into a predicate function. */
export function compile(schema: TSchemaLike): Validator {
  const checks: Validator[] = [];

  // TypeBox unions / literals are expressed via anyOf / unionSchemas / enum / const.
  const union: unknown = schema.anyOf ?? schema.unionSchemas ?? schema.oneOf;
  if (Array.isArray(union)) {
    const members = union.map((s) => compile(s as TSchemaLike));
    checks.push((v) => members.some((m) => m(v)));
  }

  if (Array.isArray(schema.allOf)) {
    const members = (schema.allOf as TSchemaLike[]).map((s) => compile(s));
    checks.push((v) => members.every((m) => m(v)));
  }

  if ('const' in schema) {
    const c = schema.const;
    checks.push((v) => JSON.stringify(v) === JSON.stringify(c));
  }

  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum as unknown[];
    checks.push((v) => allowed.some((a) => JSON.stringify(a) === JSON.stringify(v)));
  }

  if (schema.not) {
    const inner = compile(schema.not as TSchemaLike);
    checks.push((v) => !inner(v));
  }

  const type = schema.type as string | string[] | undefined;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    checks.push((v) => types.some((t) => matchType(t, v)));
  }

  if (typeof schema.minimum === 'number') {
    const min = schema.minimum;
    checks.push((v) => typeof v !== 'number' || v >= min);
  }
  if (typeof schema.maximum === 'number') {
    const max = schema.maximum;
    checks.push((v) => typeof v !== 'number' || v <= max);
  }
  if (typeof schema.exclusiveMinimum === 'number') {
    const min = schema.exclusiveMinimum;
    checks.push((v) => typeof v !== 'number' || v > min);
  }
  if (typeof schema.exclusiveMaximum === 'number') {
    const max = schema.exclusiveMaximum;
    checks.push((v) => typeof v !== 'number' || v < max);
  }
  if (typeof schema.multipleOf === 'number') {
    const m = schema.multipleOf;
    checks.push((v) => typeof v !== 'number' || Math.abs(v % m) < 1e-9);
  }

  if (typeof schema.minLength === 'number') {
    const n = schema.minLength;
    checks.push((v) => typeof v !== 'string' || v.length >= n);
  }
  if (typeof schema.maxLength === 'number') {
    const n = schema.maxLength;
    checks.push((v) => typeof v !== 'string' || v.length <= n);
  }
  if (typeof schema.pattern === 'string') {
    const re = new RegExp(schema.pattern);
    checks.push((v) => typeof v !== 'string' || re.test(v));
  }
  if (schema.format === 'date-time') {
    checks.push((v) => typeof v !== 'string' || DATE_TIME_RE.test(v));
  }

  if (isObject(schema.properties) || schema.additionalProperties !== undefined) {
    const props = (schema.properties ?? {}) as Record<string, TSchemaLike>;
    const compiledProps: Record<string, Validator> = {};
    for (const key of Object.keys(props)) compiledProps[key] = compile(props[key]);

    const required = Array.isArray(schema.required) ? (schema.required as string[]) : undefined;
    if (required) {
      checks.push((v) => isObject(v) && required.every((k) => v[k] !== undefined));
    }

    const addl = schema.additionalProperties;
    if (addl === false) {
      checks.push((v) => isObject(v) && Object.keys(v).every((k) => k in compiledProps));
    } else if (isObject(addl)) {
      const addlValidator = compile(addl as TSchemaLike);
      checks.push((v) =>
        isObject(v) &&
        Object.entries(v).every(([k, val]) => k in compiledProps || addlValidator(val)),
      );
    }

    checks.push((v) => {
      if (!isObject(v)) return true; // type mismatch handled by the `type` check
      for (const [k, val] of Object.entries(v)) {
        const cv = compiledProps[k];
        if (cv && !cv(val)) return false;
      }
      return true;
    });
  }

  if (schema.items) {
    const itemValidator = compile(schema.items as TSchemaLike);
    checks.push((v) => Array.isArray(v) && v.every((x) => itemValidator(x)));
    if (schema.uniqueItems === true) {
      checks.push((v) => {
        if (!Array.isArray(v)) return true;
        const seen = new Set<string>();
        for (const x of v) {
          const key = JSON.stringify(x) ?? String(x);
          if (seen.has(key)) return false;
          seen.add(key);
        }
        return true;
      });
    }
  }
  if (typeof schema.minItems === 'number') {
    const n = schema.minItems;
    checks.push((v) => !Array.isArray(v) || v.length >= n);
  }
  if (typeof schema.maxItems === 'number') {
    const n = schema.maxItems;
    checks.push((v) => !Array.isArray(v) || v.length <= n);
  }

  return (value) => checks.every((c) => c(value));
}

function describe(s: TSchemaLike): string {
  if (Array.isArray(s.anyOf)) {
    return `anyOf ${(s.anyOf as TSchemaLike[]).map(describe).join(' | ')}`;
  }
  if (Array.isArray(s.enum)) {
    return `enum(${(s.enum as unknown[]).map((e) => JSON.stringify(e)).join('|')})`;
  }
  if ('const' in s) return `const ${JSON.stringify(s.const)}`;
  const parts: string[] = [];
  if (s.type) parts.push(String(s.type));
  if (typeof s.minimum === 'number') parts.push(`>=${s.minimum}`);
  if (typeof s.maximum === 'number') parts.push(`<=${s.maximum}`);
  if (typeof s.minLength === 'number') parts.push(`minLength ${s.minLength}`);
  if (typeof s.pattern === 'string') parts.push(`/${s.pattern}/`);
  if (s.format) parts.push(`format:${s.format}`);
  return parts.join(' ') || 'any';
}

/** Collect all validation problems for `value` against `schema` (with nested paths). */
export function validateWithIssues(
  schema: TSchemaLike,
  value: unknown,
): ValidationErrorDetail[] {
  const issues: ValidationErrorDetail[] = [];

  const walk = (s: TSchemaLike, v: unknown, path: string): void => {
    const ok = compile(s)(v);
    if (!ok) issues.push({ path, message: `failed schema check (${describe(s)})` });

    if (isObject(s.properties) && isObject(v)) {
      for (const [key, sub] of Object.entries(s.properties as Record<string, TSchemaLike>)) {
        if (v[key] !== undefined) walk(sub, v[key], path ? `${path}.${key}` : key);
      }
      const required = Array.isArray(s.required) ? (s.required as string[]) : [];
      for (const req of required) {
        if (v[req] === undefined) {
          issues.push({
            path: path ? `${path}.${req}` : req,
            message: 'required property missing',
          });
        }
      }
    }

    if (s.items && Array.isArray(v)) {
      v.forEach((item, i) => walk(s.items as TSchemaLike, item, `${path}[${i}]`));
    }
  };

  walk(schema, value, '');
  return issues;
}

/** True when `value` satisfies `schema`. */
export function validate(schema: TSchemaLike, value: unknown): boolean {
  return compile(schema)(value);
}
