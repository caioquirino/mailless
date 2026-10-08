import type {
  ChangesResponse,
  Email,
  EmailFilterCondition,
  EmailSubmission,
  Filter,
  GetResponse,
  Id,
  Identity,
  Mailbox,
  MailboxFilterCondition,
  QueryChangesResponse,
  QueryResponse,
  ResultReference,
  SetResponse,
  Thread,
} from '@mailless/jmap-core';

/*
 * What each method takes and answers with, for the methods this package
 * knows. A method that is not here can still be called: its arguments and
 * its response are then plain objects. To have types for more, add to
 * `MethodMap`:
 *
 *   declare module '@mailless/jmap-client' {
 *     interface MethodMap {
 *       'Calendar/get': { args: GetArguments; response: GetResponse<Calendar> };
 *     }
 *   }
 */

export interface Comparator {
  property: string;
  isAscending?: boolean;
  collation?: string;
  [extra: string]: unknown;
}

export interface GetArguments {
  accountId?: Id;
  ids?: Id[] | null;
  properties?: string[] | null;
}

export interface ChangesArguments {
  accountId?: Id;
  sinceState: string;
  maxChanges?: number | null;
}

export interface SetArguments<T> {
  accountId?: Id;
  ifInState?: string | null;
  create?: Record<Id, Partial<T>> | null;
  /** By id: the properties to change, or patches by path (`"keywords/$seen": true`). */
  update?: Record<Id, Record<string, unknown>> | null;
  destroy?: Id[] | null;
}

export interface QueryArguments<Condition> {
  accountId?: Id;
  filter?: Filter<Condition> | null;
  sort?: Comparator[] | null;
  position?: number;
  anchor?: Id | null;
  anchorOffset?: number;
  limit?: number | null;
  calculateTotal?: boolean;
}

export interface QueryChangesArguments<Condition> {
  accountId?: Id;
  filter?: Filter<Condition> | null;
  sort?: Comparator[] | null;
  sinceQueryState: string;
  maxChanges?: number | null;
  upToId?: Id | null;
  calculateTotal?: boolean;
}

export interface EmailGetArguments extends GetArguments {
  bodyProperties?: string[];
  fetchTextBodyValues?: boolean;
  fetchHTMLBodyValues?: boolean;
  fetchAllBodyValues?: boolean;
  maxBodyValueBytes?: number;
}

interface Standard<T, Condition> {
  get: { args: GetArguments; response: GetResponse<T> };
  changes: { args: ChangesArguments; response: ChangesResponse };
  set: { args: SetArguments<T>; response: SetResponse<T> };
  query: { args: QueryArguments<Condition>; response: QueryResponse };
  queryChanges: {
    args: QueryChangesArguments<Condition>;
    response: QueryChangesResponse;
  };
}

export interface MethodMap {
  'Core/echo': {
    args: Record<string, unknown>;
    response: Record<string, unknown>;
  };

  'Mailbox/get': Standard<Mailbox, MailboxFilterCondition>['get'];
  'Mailbox/changes': {
    args: ChangesArguments;
    response: ChangesResponse & { updatedProperties: string[] | null };
  };
  'Mailbox/query': {
    args: QueryArguments<MailboxFilterCondition> & {
      sortAsTree?: boolean;
      filterAsTree?: boolean;
    };
    response: QueryResponse;
  };
  'Mailbox/queryChanges': Standard<
    Mailbox,
    MailboxFilterCondition
  >['queryChanges'];
  'Mailbox/set': {
    args: SetArguments<Mailbox> & { onDestroyRemoveEmails?: boolean };
    response: SetResponse<Mailbox>;
  };

  'Thread/get': Standard<Thread, never>['get'];
  'Thread/changes': Standard<Thread, never>['changes'];

  'Email/get': { args: EmailGetArguments; response: GetResponse<Email> };
  'Email/changes': Standard<Email, EmailFilterCondition>['changes'];
  'Email/query': {
    args: QueryArguments<EmailFilterCondition> & { collapseThreads?: boolean };
    response: QueryResponse;
  };
  'Email/queryChanges': {
    args: QueryChangesArguments<EmailFilterCondition> & {
      collapseThreads?: boolean;
    };
    response: QueryChangesResponse;
  };
  'Email/set': Standard<Email, EmailFilterCondition>['set'];

  'Identity/get': Standard<Identity, never>['get'];
  'Identity/changes': Standard<Identity, never>['changes'];
  'Identity/set': Standard<Identity, never>['set'];

  'EmailSubmission/get': Standard<EmailSubmission, never>['get'];
  'EmailSubmission/changes': Standard<EmailSubmission, never>['changes'];
  'EmailSubmission/set': {
    args: SetArguments<EmailSubmission> & {
      onSuccessUpdateEmail?: Record<Id, Record<string, unknown>> | null;
      onSuccessDestroyEmail?: Id[] | null;
    };
    response: SetResponse<EmailSubmission>;
  };
}

/**
 * Arguments as a call may give them: each as itself, or as `#name` with a
 * reference to the result of an earlier call in the same batch.
 */
export type WithReferences<Args> = {
  [K in keyof Args]: Args[K];
} & {
  [K in keyof Args as `#${K & string}`]?: ResultReference;
};

export type ArgumentsOf<Name extends string> = Name extends keyof MethodMap
  ? WithReferences<MethodMap[Name]['args']>
  : Record<string, unknown>;

export type ResponseOf<Name extends string> = Name extends keyof MethodMap
  ? MethodMap[Name]['response']
  : Record<string, unknown>;
