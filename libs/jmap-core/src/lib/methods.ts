import type { SetError } from './errors.js';
import type { Id } from './types.js';

/** A filter is either an operator node or a type-specific condition object. */
export interface FilterOperator<Condition> {
  operator: 'AND' | 'OR' | 'NOT';
  conditions: Filter<Condition>[];
}
export type Filter<Condition> = FilterOperator<Condition> | Condition;

export interface GetResponse<T> {
  accountId: Id;
  state: string;
  list: T[];
  notFound: Id[];
}

export interface ChangesResponse {
  accountId: Id;
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: Id[];
  updated: Id[];
  destroyed: Id[];
}

export interface SetResponse<T> {
  accountId: Id;
  oldState: string | null;
  newState: string;
  created: Record<Id, Partial<T>> | null;
  updated: Record<Id, Partial<T> | null> | null;
  destroyed: Id[] | null;
  notCreated: Record<Id, SetError> | null;
  notUpdated: Record<Id, SetError> | null;
  notDestroyed: Record<Id, SetError> | null;
}

export interface QueryResponse {
  accountId: Id;
  queryState: string;
  canCalculateChanges: boolean;
  position: number;
  ids: Id[];
  total?: number;
  limit?: number;
}

export interface AddedItem {
  id: Id;
  index: number;
}

export interface QueryChangesResponse {
  accountId: Id;
  oldQueryState: string;
  newQueryState: string;
  total?: number;
  removed: Id[];
  added: AddedItem[];
}
