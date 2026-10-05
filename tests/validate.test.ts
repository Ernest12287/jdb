import { describe, it, expect, afterEach } from 'vitest';
import { validate, validateWithIssues } from '../src/validate.js';
import { objectSchema } from './helpers.js';

const User = objectSchema({
  id: { type: 'string' },
  age: { type: 'integer', minimum: 0 },
  role: { anyOf: [{ const: 'admin' }, { const: 'cashier' }] },
  tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
});

describe('validator (JSON-schema subset / TypeBox compatible)', () => {
  it('accepts a valid record', () => {
    expect(
      validate(User, { id: 'u1', age: 30, role: 'admin', tags: ['a', 'b'] }),
    ).toBe(true);
  });

  it('rejects wrong types', () => {
    expect(validate(User, { id: 1, age: 30, role: 'admin', tags: [] })).toBe(false);
    expect(validate(User, { id: 'u', age: 1.5, role: 'admin', tags: [] })).toBe(false);
  });

  it('rejects unknown enum members', () => {
    expect(validate(User, { id: 'u', age: 1, role: 'wizard', tags: [] })).toBe(false);
  });

  it('rejects duplicate array items when uniqueItems', () => {
    expect(validate(User, { id: 'u', age: 1, role: 'admin', tags: ['x', 'x'] })).toBe(false);
  });

  it('reports nested issue paths', () => {
    const issues = validateWithIssues(User, { id: 'u', age: -1, role: 'admin', tags: [] });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.path === 'age')).toBe(true);
  });

  it('supports pattern, format:date-time and bounds', () => {
    const S = objectSchema({
      code: { type: 'string', pattern: '^[A-Z]{3}$' },
      when: { type: 'string', format: 'date-time' },
      price: { type: 'number', minimum: 0, maximum: 100 },
    });
    expect(validate(S, { code: 'ABC', when: '2026-10-05T14:30:00.000Z', price: 12.5 })).toBe(true);
    expect(validate(S, { code: 'abc', when: 'nope', price: 101 })).toBe(false);
  });
});
