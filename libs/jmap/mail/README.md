# @mailless/jmap-mail

Mail for a JMAP server (RFC 8621), as a module for
[`@mailless/jmap-engine`](../engine): mailboxes, emails and threads, and with
a transport also sending, the vacation response (RFC 8621 §8) and read
receipts (RFC 9007). With it come blob management (RFC 9404) and the quota of
what mail takes up (RFC 9425).

```ts
import { createJmapEngine } from '@mailless/jmap-engine';
import { importMessage, mailModule } from '@mailless/jmap-mail';

const engine = createJmapEngine({
  storage,
  urls,
  modules: [mailModule({ transport, identities, quota: { maxOctets } })],
});

// Mail that did not come through JMAP enters an account this way.
await importMessage(engine.contextFor(auth), raw, { mailboxRole: 'inbox' });
```

`importMessage`, `recordDelivery` and `sendScheduled` take a context, which
the engine gives with `contextFor(auth)`.
[`@mailless/jmap-server`](../server) wraps all of this as one server, and its
README describes every method, option and choice in detail.

The module reads and writes messages with its own MIME reader and composer,
so a message is stored and served exactly as it arrived.
