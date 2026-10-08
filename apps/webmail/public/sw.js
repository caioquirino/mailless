/*
 * The webmail's service worker. It does one thing: when the mail server says
 * mail arrived, it tells the person, whether or not the webmail is open.
 *
 * It holds no sign-in and reads no mail. What a notification says beyond
 * "New mail" comes from a webmail tab that is open and signed in, when there
 * is one; when someone is looking at such a tab, nothing is shown at all.
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

  const answers = await ask(tabs, message ? message.changed : undefined);
  if (answers.some((answer) => answer.quiet)) return;
  const said = answers.find((answer) => typeof answer.title === 'string');
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
      const open = (await windows()).find((tab) => tab.url.startsWith(scope));
      if (open) return open.focus();
      return sw.clients.openWindow(scope);
    })(),
  );
});
