/*
 * The webmail's service worker. It tells the person what the mail server
 * says is worth telling, whether or not the webmail is open: that mail
 * arrived, and that something in their calendar is about to begin.
 *
 * It holds no sign-in and reads no mail. Who wrote and about what comes with
 * the word that mail arrived, encrypted by the server to this browser; a
 * webmail tab that is open and signed in can say the same. When someone is
 * looking at such a tab, nothing is shown at all.
 */

/** The worker itself. */
const sw = globalThis;

/** How long an open tab has to say what arrived before the plain notice is shown. */
const ANSWER_MS = 4000;

sw.addEventListener('install', () => sw.skipWaiting());
sw.addEventListener('activate', (event) => event.waitUntil(sw.clients.claim()));

function windows() {
  return sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

/** Asks every open tab what arrived. Resolves with their answers, or with none when nobody answers in time. */
function ask(tabs, changed) {
  return new Promise((resolve) => {
    if (tabs.length === 0) return resolve([]);
    const answers = [];
    let waiting = tabs.length;
    const timer = setTimeout(() => resolve(answers), ANSWER_MS);
    const hear = (answer) => {
      if (answer) answers.push(answer);
      waiting -= 1;
      // Someone is looking at their mail: no need to hear from the rest.
      if (waiting === 0 || (answer && answer.quiet)) {
        clearTimeout(timer);
        resolve(answers);
      }
    };
    for (const tab of tabs) {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => hear(event.data);
      tab.postMessage({ type: 'mailless-state-change', changed }, [
        channel.port2,
      ]);
    }
  });
}

/** A line of text, if that is what it is. */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** What to say of the messages the server said arrived. Null when it said nothing of them. */
function announce(message) {
  const listed = message ? message['mailless:arrived'] : undefined;
  const arrived = (Array.isArray(listed) ? listed : [])
    .filter((each) => each && typeof each === 'object')
    .map((each) => ({
      from: text(each.from) || 'Someone',
      subject: text(each.subject) || '(no subject)',
      preview: text(each.preview),
    }));
  const [only] = arrived;
  if (!only) return null;
  if (arrived.length === 1) {
    return {
      title: only.from,
      body: [only.subject, only.preview].filter(Boolean).join('\n'),
    };
  }
  return {
    title: 'New messages',
    body: arrived.map((each) => `${each.from}: ${each.subject}`).join('\n'),
  };
}

/** When an event is, in the words a notification has room for: "in 30 min", "now", "tomorrow". */
function howSoon(start, whole, now) {
  const day = (date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(start) - day(now)) / 86400000);
  if (whole) {
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    return start.toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  }
  const minutes = Math.round((start.getTime() - now.getTime()) / 60000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 24 * 60 && minutes % 60 === 0) {
    return `in ${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`;
  }
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** The reminders the server said have come due, each as a notification of its own. */
function reminders(message, now) {
  const listed = message ? message['mailless:alerts'] : undefined;
  return (Array.isArray(listed) ? listed : [])
    .filter((each) => each && typeof each === 'object')
    .flatMap((each) => {
      const start = new Date(each.utcStart);
      const end = new Date(each.utcEnd);
      if (Number.isNaN(start.getTime())) return [];
      const whole = each.showWithoutTime === true;
      const time = (date) =>
        date.toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        });
      const when = whole
        ? ''
        : Number.isNaN(end.getTime()) || end.getTime() === start.getTime()
          ? time(start)
          : `${time(start)} – ${time(end)}`;
      const key = [
        start.getFullYear(),
        String(start.getMonth() + 1).padStart(2, '0'),
        String(start.getDate()).padStart(2, '0'),
      ].join('-');
      return [
        {
          title: `${text(each.title) || 'An event'} · ${howSoon(start, whole, now)}`,
          body: [when, text(each.location)].filter(Boolean).join(' · '),
          // One for each time of each event: a second reminder of it takes the place of the first.
          tag: `mailless-event-${text(each.eventId)}-${each.utcStart}`,
          // The week it is in, to go to when the notification is pressed.
          path: `calendar/week/${key}`,
        },
      ];
    });
}

async function onPush(data) {
  let message = null;
  try {
    message = data ? data.json() : null;
  } catch {
    // Not something this server sent; treated as word that something arrived.
  }
  const tabs = await windows();

  // The server checking that pushes reach this browser: the tab that asked finishes the job.
  if (message && message['@type'] === 'PushVerification') {
    for (const tab of tabs) {
      tab.postMessage({
        type: 'mailless-push-verification',
        pushSubscriptionId: message.pushSubscriptionId,
        verificationCode: message.verificationCode,
      });
    }
    return;
  }

  // Something in the calendar is about to begin: said whether or not anyone is
  // looking at their mail, which is no reason not to be reminded.
  const due = reminders(message, new Date());
  if (due.length > 0) {
    for (const each of due) {
      await sw.registration.showNotification(each.title, {
        body: each.body,
        icon: new URL('favicon.svg', sw.registration.scope).href,
        tag: each.tag,
        renotify: true,
        data: { path: each.path },
      });
    }
    return;
  }

  const answers = await ask(tabs, message ? message.changed : undefined);
  if (answers.some((answer) => answer.quiet)) return;
  // The server knows what arrived; a tab knows it too, when the server did not say.
  const said =
    announce(message) ??
    answers.find((answer) => typeof answer.title === 'string');
  await sw.registration.showNotification(said ? said.title : 'New mail', {
    body: said && typeof said.body === 'string' ? said.body : '',
    icon: new URL('favicon.svg', sw.registration.scope).href,
    // One notice at a time: a newer one takes the place of the last.
    tag: 'mailless-new-mail',
    renotify: true,
  });
}

sw.addEventListener('push', (event) => event.waitUntil(onPush(event.data)));

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const scope = sw.registration.scope;
      // A reminder leads to the week its event is in; anything else to the mail.
      const path =
        event.notification.data &&
        typeof event.notification.data.path === 'string'
          ? event.notification.data.path
          : '';
      const open = (await windows()).find((tab) => tab.url.startsWith(scope));
      if (open) {
        if (path && typeof open.navigate === 'function') {
          await open.navigate(new URL(path, scope).href).catch(() => undefined);
        }
        return open.focus();
      }
      return sw.clients.openWindow(new URL(path, scope).href);
    })(),
  );
});
