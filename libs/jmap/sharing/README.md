# @mailless/jmap-sharing

Sharing for a JMAP server (RFC 9670), as a module for
[`@mailless/jmap-engine`](../engine): the principals who own the accounts a
user may use, and share notifications.

```ts
import { createJmapEngine } from '@mailless/jmap-engine';
import { sharingModule } from '@mailless/jmap-sharing';

const engine = createJmapEngine({ storage, urls, modules: [sharingModule()] });
```

Which accounts a user may use is the host's to say, with each request
(`auth.sharedAccounts`); this module is how clients see it. See
[Principals](../server/README.md#principals) in the server's README.
