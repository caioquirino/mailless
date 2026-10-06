import {
  GetArgumentsSchema,
  IdSchema,
  QueryArgumentsSchema,
  RequestSchema,
  UTCDateSchema,
} from './schemas.js';

describe('schemas', () => {
  it('accepts valid ids and rejects invalid ones', () => {
    expect(IdSchema.safeParse('Ab0_-').success).toBe(true);
    expect(IdSchema.safeParse('').success).toBe(false);
    expect(IdSchema.safeParse('a.b').success).toBe(false);
    expect(IdSchema.safeParse('a'.repeat(256)).success).toBe(false);
  });

  it('requires UTC dates in normalised form', () => {
    expect(UTCDateSchema.safeParse('2026-01-31T12:00:00Z').success).toBe(true);
    expect(UTCDateSchema.safeParse('2026-01-31T12:00:00.5Z').success).toBe(
      true,
    );
    expect(UTCDateSchema.safeParse('2026-01-31T12:00:00+01:00').success).toBe(
      false,
    );
    expect(UTCDateSchema.safeParse('2026-01-31T12:00:00.50Z').success).toBe(
      false,
    );
  });

  it('parses a request envelope', () => {
    const parsed = RequestSchema.safeParse({
      using: ['urn:ietf:params:jmap:core'],
      methodCalls: [['Core/echo', { hello: true }, 'c1']],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects malformed invocations', () => {
    expect(
      RequestSchema.safeParse({ using: [], methodCalls: [['Core/echo', {}]] })
        .success,
    ).toBe(false);
    expect(
      RequestSchema.safeParse({ using: [], methodCalls: [['x', [], 'c1']] })
        .success,
    ).toBe(false);
  });

  it('rejects unknown arguments on standard methods', () => {
    expect(GetArgumentsSchema.safeParse({ accountId: 'a' }).success).toBe(true);
    expect(
      GetArgumentsSchema.safeParse({ accountId: 'a', bogus: 1 }).success,
    ).toBe(false);
  });

  it('validates query paging arguments', () => {
    expect(
      QueryArgumentsSchema.safeParse({
        accountId: 'a',
        position: -5,
        limit: 10,
      }).success,
    ).toBe(true);
    expect(
      QueryArgumentsSchema.safeParse({ accountId: 'a', limit: -1 }).success,
    ).toBe(false);
  });
});
