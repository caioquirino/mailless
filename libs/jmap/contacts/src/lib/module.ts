import { CAPABILITY_CONTACTS } from '@mailless/jmap-core';
import type { JmapModule } from '@mailless/jmap-engine';
import {
  ADDRESS_BOOK,
  CONTACT_CARD,
  contactMethods,
  provisionAddressBooks,
} from './contacts.js';

/** Contacts for a JMAP server (RFC 9610): address books, and the cards in them. */
export function contactsModule(): JmapModule {
  return {
    name: 'contacts',
    capabilities: { [CAPABILITY_CONTACTS]: {} },
    accountCapabilities: (access) => ({
      [CAPABILITY_CONTACTS]: {
        maxAddressBooksPerCard: null,
        mayCreateAddressBook: !access.isReadOnly,
      },
    }),
    methods: Object.fromEntries(
      Object.entries(contactMethods).map(([name, handler]) => [
        name,
        { capability: CAPABILITY_CONTACTS, handler },
      ]),
    ),
    provisionAccount: provisionAddressBooks,
    pushedTypes: [ADDRESS_BOOK, CONTACT_CARD],
  };
}
