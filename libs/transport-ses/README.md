# @mailless/transport-ses

An Amazon SES `MailTransport` for [`@mailless/jmap-server`](../jmap-server):
it is what makes `EmailSubmission/set` actually send.

```ts
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { createJmapServer } from '@mailless/jmap-server';
import { SesMailTransport } from '@mailless/transport-ses';

const jmap = createJmapServer({
  storage,
  urls,
  transport: new SesMailTransport({ client: new SESv2Client({}) }),
  identities: (auth) => [{ id: 'main', email: 'me@example.com' }],
});
```

The message is sent as raw MIME to exactly the envelope recipients, so Bcc
recipients receive it without appearing in it. Errors that mean SES will never
accept the message (unverified sender, sandbox restriction, suspended account)
become `MailRejectedError`, which the server reports to the client as
`forbiddenToSend`; throttling and outages are passed through as failures.

The sending address or its domain must be a verified SES identity, and the
caller needs `ses:SendEmail` on it. A new SES account is in the sandbox and can
only send to verified addresses until AWS grants production access.

Requires Node.js 22.12 or newer. Licensed under Apache-2.0.
