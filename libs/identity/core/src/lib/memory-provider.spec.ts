import { InMemoryIdentityProvider } from './memory-provider.js';
import { describeIdentityContract } from './provider-contract.js';

describeIdentityContract('in-memory', async () => {
  const provider = new InMemoryIdentityProvider({ roles: ['admin'] });
  return {
    provider,
    signIn: async (username, password) => provider.signIn(username, password),
    enrolPasskey: async (token, name) => provider.enrolPasskey(token, name).id,
  };
});
