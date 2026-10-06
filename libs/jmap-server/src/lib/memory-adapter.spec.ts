import { InMemoryStorageAdapter } from '../memory.js';
import {
  describeJmapConformance,
  describeStorageContract,
} from '../testing.js';

describeStorageContract('in-memory', () => new InMemoryStorageAdapter());
describeJmapConformance('in-memory', () => new InMemoryStorageAdapter());
