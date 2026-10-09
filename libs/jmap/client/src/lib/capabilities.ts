import {
  CAPABILITY_BLOB,
  CAPABILITY_BLOCKED_SENDERS,
  CAPABILITY_CALENDAR_PROPOSALS,
  CAPABILITY_CALENDARS,
  CAPABILITY_CONTACTS,
  CAPABILITY_CORE,
  CAPABILITY_MAIL,
  CAPABILITY_MDN,
  CAPABILITY_PRINCIPALS,
  CAPABILITY_QUOTA,
  CAPABILITY_SUBMISSION,
  CAPABILITY_TAGS,
  CAPABILITY_VACATION,
} from '@mailless/jmap-core';

/** The capability each data type's methods belong to. */
const BY_TYPE: Record<string, string> = {
  Core: CAPABILITY_CORE,
  PushSubscription: CAPABILITY_CORE,
  Mailbox: CAPABILITY_MAIL,
  Thread: CAPABILITY_MAIL,
  Email: CAPABILITY_MAIL,
  SearchSnippet: CAPABILITY_MAIL,
  Identity: CAPABILITY_SUBMISSION,
  EmailSubmission: CAPABILITY_SUBMISSION,
  VacationResponse: CAPABILITY_VACATION,
  Blob: CAPABILITY_BLOB,
  Quota: CAPABILITY_QUOTA,
  MDN: CAPABILITY_MDN,
  Principal: CAPABILITY_PRINCIPALS,
  ShareNotification: CAPABILITY_PRINCIPALS,
  AddressBook: CAPABILITY_CONTACTS,
  ContactCard: CAPABILITY_CONTACTS,
  Calendar: CAPABILITY_CALENDARS,
  CalendarEvent: CAPABILITY_CALENDARS,
  CalendarProposal: CAPABILITY_CALENDAR_PROPOSALS,
  Tag: CAPABILITY_TAGS,
  BlockedSender: CAPABILITY_BLOCKED_SENDERS,
};

/** Copying a blob between accounts is part of the core (RFC 8620 §6.3); the rest of Blob is RFC 9404. */
const BY_METHOD: Record<string, string> = {
  'Blob/copy': CAPABILITY_CORE,
  // Asked of a principal, and answered from their calendars.
  'Principal/getAvailability': CAPABILITY_CALENDARS,
};

/** The capability a method needs in `using`, or undefined for one this package does not know. */
export function capabilityOf(method: string): string | undefined {
  return BY_METHOD[method] ?? BY_TYPE[method.split('/')[0] ?? ''];
}

/**
 * What a request must say it uses, for the methods it calls. Sending mail and
 * the vacation response are defined on top of mail, so mail comes with them.
 */
export function capabilitiesFor(methods: readonly string[]): string[] {
  const using = new Set<string>([CAPABILITY_CORE]);
  for (const method of methods) {
    const capability = capabilityOf(method);
    if (!capability) {
      throw new Error(
        `Which capability ${method} belongs to is not known: say so with \`using\``,
      );
    }
    using.add(capability);
    if (
      capability === CAPABILITY_SUBMISSION ||
      capability === CAPABILITY_VACATION ||
      capability === CAPABILITY_MDN
    ) {
      using.add(CAPABILITY_MAIL);
    }
  }
  return [...using];
}
