import {
  MethodError,
  type Comparator,
  type QueryResponse,
} from '@mailless/jmap-core';
import type { MethodContext } from '../context.js';

type Condition = Record<string, unknown>;
export type CompareFn<T> = (a: T, b: T) => number;

export interface QuerySpec<T extends { id: string }> {
  /** Throws invalidArguments or unsupportedFilter for a condition it cannot evaluate. */
  validateCondition(condition: Condition): void;
  matches(item: T, condition: Condition): boolean;
  /** Returns an ascending comparison for a sort property, or throws unsupportedSort. */
  comparator(comparator: Comparator): CompareFn<T>;
}

const OPERATORS = ['AND', 'OR', 'NOT'];

function isOperator(filter: Condition): boolean {
  return Object.prototype.hasOwnProperty.call(filter, 'operator');
}

/** Checks the whole filter tree up front so errors do not depend on which objects exist. */
export function validateFilter(
  filter: Condition,
  validateCondition: (condition: Condition) => void,
  depth = 0,
): void {
  if (depth > 32) {
    throw new MethodError(
      'unsupportedFilter',
      'The filter is nested too deeply',
    );
  }
  if (!isOperator(filter)) {
    validateCondition(filter);
    return;
  }
  const { operator, conditions } = filter;
  if (typeof operator !== 'string' || !OPERATORS.includes(operator)) {
    throw new MethodError(
      'invalidArguments',
      'filter operator must be AND, OR or NOT',
    );
  }
  if (!Array.isArray(conditions)) {
    throw new MethodError(
      'invalidArguments',
      'filter conditions must be an array',
    );
  }
  for (const condition of conditions) {
    if (typeof condition !== 'object' || condition === null) {
      throw new MethodError(
        'invalidArguments',
        'each filter condition must be an object',
      );
    }
    validateFilter(condition as Condition, validateCondition, depth + 1);
  }
}

export function evaluateFilter<T>(
  filter: Condition,
  item: T,
  matches: (item: T, condition: Condition) => boolean,
): boolean {
  if (!isOperator(filter)) return matches(item, filter);
  const conditions = filter['conditions'] as Condition[];
  switch (filter['operator']) {
    case 'AND':
      return conditions.every((c) => evaluateFilter(c, item, matches));
    case 'OR':
      return conditions.some((c) => evaluateFilter(c, item, matches));
    default:
      return !conditions.some((c) => evaluateFilter(c, item, matches));
  }
}

/** Values of one condition property that every match must have, found through nested ANDs. */
export function requiredConditionValues(
  filter: Condition | null | undefined,
  property: string,
): unknown[] {
  if (!filter) return [];
  if (!isOperator(filter)) {
    return Object.prototype.hasOwnProperty.call(filter, property)
      ? [filter[property]]
      : [];
  }
  if (filter['operator'] !== 'AND') return [];
  return (filter['conditions'] as Condition[]).flatMap((condition) =>
    requiredConditionValues(condition, property),
  );
}

/** Whether any condition of the filter, at any depth, has one of these properties. */
export function filterUses(
  filter: Condition | null | undefined,
  properties: readonly string[],
): boolean {
  if (!filter) return false;
  if (!isOperator(filter)) {
    return properties.some((property) =>
      Object.prototype.hasOwnProperty.call(filter, property),
    );
  }
  const conditions = filter['conditions'];
  return (
    Array.isArray(conditions) &&
    conditions.some(
      (condition) =>
        typeof condition === 'object' &&
        condition !== null &&
        filterUses(condition as Condition, properties),
    )
  );
}

export function filterAndSort<T extends { id: string }>(
  items: readonly T[],
  filter: Condition | null | undefined,
  sort: readonly Comparator[] | null | undefined,
  spec: QuerySpec<T>,
): T[] {
  if (filter) validateFilter(filter, (c) => spec.validateCondition(c));
  const comparators = (sort ?? []).map((comparator) => {
    const compare = spec.comparator(comparator);
    return comparator.isAscending === false
      ? (a: T, b: T) => compare(b, a)
      : compare;
  });

  const matched = filter
    ? items.filter((item) =>
        evaluateFilter(filter, item, (i, c) => spec.matches(i, c)),
      )
    : [...items];

  return matched.sort((a, b) => {
    for (const compare of comparators) {
      const result = compare(a, b);
      if (result !== 0) return result;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface PagingArguments {
  position?: number | undefined;
  anchor?: string | null | undefined;
  anchorOffset?: number | undefined;
  limit?: number | null | undefined;
  calculateTotal?: boolean | undefined;
}

const MAX_QUERY_LIMIT = 1000;

/** Windowing rules of RFC 8620 §5.5 applied to an already sorted id list. */
export function paginate(
  ctx: MethodContext,
  ids: readonly string[],
  args: PagingArguments,
  queryState: string,
): QueryResponse {
  let position: number;
  if (args.anchor !== null && args.anchor !== undefined) {
    const index = ids.indexOf(args.anchor);
    if (index === -1) throw new MethodError('anchorNotFound');
    position = Math.max(0, index + (args.anchorOffset ?? 0));
  } else {
    const requested = args.position ?? 0;
    position = requested < 0 ? Math.max(0, ids.length + requested) : requested;
  }

  const requestedLimit = args.limit ?? MAX_QUERY_LIMIT;
  const limit = Math.min(requestedLimit, MAX_QUERY_LIMIT);

  return {
    accountId: ctx.auth.accountId,
    queryState,
    canCalculateChanges: false,
    // Past the end there is no first result to give the index of.
    position: position >= ids.length ? 0 : position,
    ids: ids.slice(position, position + limit),
    ...(args.calculateTotal ? { total: ids.length } : {}),
    ...(limit < requestedLimit ? { limit } : {}),
  };
}

export function compareStrings(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}
