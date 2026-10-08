/*
 * JSContact (RFC 9553) as far as a server that stores cards needs it: is this
 * a valid Card? Every property the RFC defines is checked for its type and
 * its mandatory members. A property the RFC does not define is kept as it is
 * (§1.7.4), since it may come from an extension this code does not know.
 */

/** Checks a value, adding the path of whatever is wrong with it. */
type Check = (value: unknown, path: string, problems: string[]) => void;

const ID = /^[A-Za-z0-9_-]{1,255}$/;
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d*[1-9])?Z$/;

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const check =
  (valid: (value: unknown) => boolean): Check =>
  (value, path, problems) => {
    if (!valid(value)) problems.push(path);
  };

const string = check((value) => typeof value === 'string');
const nonEmptyString = check(
  (value) => typeof value === 'string' && value.length > 0,
);
const boolean = check((value) => typeof value === 'boolean');
const unsignedInt = check(
  (value) => Number.isSafeInteger(value) && (value as number) >= 0,
);
const utcDateTime = check(
  (value) =>
    typeof value === 'string' &&
    UTC_DATE_TIME.test(value) &&
    !Number.isNaN(Date.parse(value)),
);
/** A set: a map in which every value is true. */
const setOf = check(
  (value) =>
    isPlainObject(value) && Object.values(value).every((item) => item === true),
);
const preference = check(
  (value) =>
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 100,
);
const anyObject = check(isPlainObject);

const listOf =
  (item: Check): Check =>
  (value, path, problems) => {
    if (!Array.isArray(value)) {
      problems.push(path);
      return;
    }
    value.forEach((entry, index) => item(entry, `${path}/${index}`, problems));
  };

/** A map of objects. Where the keys are Ids (§1.4.1), they must look like one. */
const mapOf =
  (item: Check, keysAreIds = true): Check =>
  (value, path, problems) => {
    if (!isPlainObject(value)) {
      problems.push(path);
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (keysAreIds && !ID.test(key)) problems.push(`${path}/${key}`);
      else item(entry, `${path}/${key}`, problems);
    }
  };

/**
 * An object of a JSContact type. A name that differs from a defined one only
 * in its capitals is an error (§1.7.1), and so is the reserved name `extra`.
 */
function object(
  type: string,
  fields: Record<string, Check>,
  required: readonly string[] = [],
): Check {
  const known = new Map(
    Object.keys(fields).map((name) => [name.toLowerCase(), name]),
  );
  return (value, path, problems) => {
    if (!isPlainObject(value)) {
      problems.push(path);
      return;
    }
    for (const name of required) {
      if (value[name] === undefined) problems.push(`${path}/${name}`);
    }
    for (const [name, member] of Object.entries(value)) {
      const here = `${path}/${name}`;
      if (name === '@type') {
        if (member !== type) problems.push(here);
      } else if (name === 'extra') {
        problems.push(here);
      } else if (fields[name]) {
        fields[name](member, here, problems);
      } else if (known.has(name.toLowerCase())) {
        problems.push(here);
      }
    }
  };
}

/** What most of the things a card lists have in common. */
const common = { contexts: setOf, pref: preference, label: string };
const resource = { ...common, kind: string, uri: string, mediaType: string };
const phonetics = { phoneticScript: string, phoneticSystem: string };

const address = object('Address', {
  components: listOf(
    object(
      'AddressComponent',
      { value: string, kind: string, phonetic: string },
      ['value', 'kind'],
    ),
  ),
  isOrdered: boolean,
  countryCode: string,
  coordinates: string,
  timeZone: string,
  contexts: setOf,
  full: string,
  defaultSeparator: string,
  pref: preference,
  ...phonetics,
});

export const CARD_KINDS = [
  'individual',
  'group',
  'org',
  'location',
  'device',
  'application',
];

const CARD_FIELDS: Record<string, Check> = {
  version: check((value) => value === '1.0'),
  created: utcDateTime,
  // A value outside the registry must carry its vendor's prefix (§1.8.2).
  kind: check(
    (value) =>
      typeof value === 'string' &&
      (CARD_KINDS.includes(value) || /^[^:]+:.+/.test(value)),
  ),
  language: string,
  members: setOf,
  prodId: nonEmptyString,
  relatedTo: mapOf(object('Relation', { relation: setOf }), false),
  uid: nonEmptyString,
  updated: utcDateTime,
  name: object('Name', {
    components: listOf(
      object(
        'NameComponent',
        { value: string, kind: string, phonetic: string },
        ['value', 'kind'],
      ),
    ),
    isOrdered: boolean,
    defaultSeparator: string,
    full: string,
    sortAs: mapOf(string, false),
    ...phonetics,
  }),
  nicknames: mapOf(object('Nickname', { name: string, ...common }, ['name'])),
  organizations: mapOf(
    object('Organization', {
      name: string,
      units: listOf(
        object('OrgUnit', { name: string, sortAs: string }, ['name']),
      ),
      sortAs: string,
      contexts: setOf,
    }),
  ),
  speakToAs: object('SpeakToAs', {
    grammaticalGender: string,
    pronouns: mapOf(
      object('Pronouns', { pronouns: string, ...common }, ['pronouns']),
    ),
  }),
  titles: mapOf(
    object('Title', { name: string, kind: string, organizationId: string }, [
      'name',
    ]),
  ),
  emails: mapOf(
    object('EmailAddress', { address: string, ...common }, ['address']),
  ),
  onlineServices: mapOf(
    object('OnlineService', {
      service: string,
      uri: string,
      user: string,
      ...common,
    }),
  ),
  phones: mapOf(
    object('Phone', { number: string, features: setOf, ...common }, ['number']),
  ),
  preferredLanguages: mapOf(
    object('LanguagePref', { language: string, ...common }, ['language']),
  ),
  calendars: mapOf(object('Calendar', resource, ['kind', 'uri'])),
  schedulingAddresses: mapOf(
    object('SchedulingAddress', { uri: string, ...common }, ['uri']),
  ),
  addresses: mapOf(address),
  cryptoKeys: mapOf(object('CryptoKey', resource, ['uri'])),
  directories: mapOf(
    object('Directory', { ...resource, listAs: unsignedInt }, ['kind', 'uri']),
  ),
  links: mapOf(object('Link', resource, ['uri'])),
  // RFC 9610 §3 lets a blob stand in for the URI; which of the two is checked with the blob.
  media: mapOf(object('Media', { ...resource, blobId: string }, ['kind'])),
  localizations: mapOf(anyObject, false),
  anniversaries: mapOf(
    object(
      'Anniversary',
      { kind: string, date: anyObject, place: address, ...common },
      ['kind', 'date'],
    ),
  ),
  keywords: setOf,
  notes: mapOf(
    object(
      'Note',
      {
        note: string,
        created: utcDateTime,
        author: object('Author', { name: string, uri: string }),
      },
      ['note'],
    ),
  ),
  personalInfo: mapOf(
    object(
      'PersonalInfo',
      {
        kind: string,
        value: string,
        level: string,
        listAs: unsignedInt,
        label: string,
      },
      ['kind', 'value'],
    ),
  ),
};

const card = object('Card', CARD_FIELDS, ['@type', 'version', 'uid']);

/** The paths of everything in a card that RFC 9553 does not allow; none when it is valid. */
export function cardProblems(value: Record<string, unknown>): string[] {
  const problems: string[] = [];
  card(value, '', problems);
  // Only a group has members (§2.1.6).
  if (value['members'] !== undefined && value['kind'] !== 'group') {
    problems.push('/members');
  }
  return [...new Set(problems.map((path) => path.slice(1)))];
}
