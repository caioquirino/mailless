# @mailless/jmap-contacts

Contacts for a JMAP server (RFC 9610), as a module for
[`@mailless/jmap-engine`](../engine): address books, and cards as JSContact
(RFC 9553).

```ts
import { createJmapEngine } from '@mailless/jmap-engine';
import { contactsModule } from '@mailless/jmap-contacts';

const engine = createJmapEngine({ storage, urls, modules: [contactsModule()] });
```

It needs nothing but the engine: a server can offer contacts without mail.
What it does, and the choices it makes, are described under
[Contacts](../server/README.md#contacts) in the server's README.
