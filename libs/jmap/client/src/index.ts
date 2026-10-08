export {
  Batch,
  BatchResult,
  createJmapClient,
  JmapClient,
  type BatchOptions,
  type Call,
  type JmapClientOptions,
} from './lib/client.js';
export { capabilitiesFor, capabilityOf } from './lib/capabilities.js';
export { JmapMethodError, JmapRequestError } from './lib/errors.js';
export {
  applyQueryChanges,
  ObjectCache,
  QueryView,
  sync,
  type ObjectCacheOptions,
  type QueryViewOptions,
  type Synced,
} from './lib/sync.js';
export type {
  ArgumentsOf,
  ChangesArguments,
  Comparator,
  EmailGetArguments,
  GetArguments,
  MethodMap,
  QueryArguments,
  QueryChangesArguments,
  ResponseOf,
  SetArguments,
  WithReferences,
} from './lib/methods.js';
