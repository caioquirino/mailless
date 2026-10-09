# @mailless/jmap-calendars

Calendars for a JMAP server (JMAP for Calendars), as a module for
[`@mailless/jmap-engine`](../engine): calendars, and events as JSCalendar
(RFC 8984).

```ts
import { createJmapEngine } from '@mailless/jmap-engine';
import { calendarsModule } from '@mailless/jmap-calendars';

const engine = createJmapEngine({
  storage,
  urls,
  modules: [calendarsModule()],
});
```

It needs nothing but the engine: a server can offer calendars without mail.

What is there: `Calendar/get`, `/changes` and `/set`; `CalendarEvent/get`,
`/changes`, `/set`, `/query`, `/queryChanges` and `/copy`; and
`Principal/getAvailability`. Events that repeat are expanded into their
occurrences, each of which can be changed or taken out by itself. What it
does, and the choices it makes, are described under
[Calendars](../server/README.md#calendars) in the server's README.
