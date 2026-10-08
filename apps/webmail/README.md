# webmail

The mailless webmail: a React application served under `/mail/`, next to the
JMAP API it is a client of.

- **Mailboxes** with what is unread in each, and new ones made on the spot.
- **Conversations**: one row for each, newest first; read, archive, delete,
  move, flag, several at a time; the trash and junk emptied in one go.
- **Reading**: each message of a conversation, its attachments saved to disk.
- **Writing**: new messages, answers and forwards, with attachments, and
  drafts kept to go on with later.
- **Search** through everything.

It talks to the server through [`@mailless/jmap-client`](../../libs/jmap/client)
and nothing else, so it works with any JMAP server that has the mail
capability, and everything it does a mail app could do too.

## How it stays up to date

The page keeps a copy of what it has looked at and asks the server what
changed since: after everything it does itself, when its tab is looked at
again, every minute while it is, and at once when the server says mail
arrived (see Notifications). One request, and a small one when
nothing happened. Opening a mailbox is one request too: the list, the
messages in it and their conversations.

What you do is shown at once, before the server has answered; if the server
refuses, it is put back and you are told.

## Notifications

"Notifications" in the top bar tells you when mail arrives, also when the
page is closed. Nothing is held open for it, by the browser or by the
server:

1. The browser gives the page an address at its own push service.
2. The page hands that address to the mail server as a push subscription
   (RFC 8620 §7.2, signed as RFC 9749 has it), asking to hear only of mail
   being delivered. The server sends a test push, and the page proves it
   arrived.
3. When mail is delivered, the server writes to that address. The browser
   wakes the page's service worker (`public/sw.js`), which shows the
   notification.

The worker holds no sign-in and reads no mail. With the webmail open in a
tab, that tab brings itself up to date and tells the worker who wrote and
what about; with none open, the notification says only that mail arrived.
When you are looking at the webmail, nothing is shown: the mail is there.

It is on for the one browser it was turned on in, and stays on until it is
turned off or you sign out, which lets go of it at both ends. On an iPhone
or iPad the browser only allows it for a page added to the home screen.

## Messages written in HTML

A message is somebody else's page, and is shown as one:

- in a frame of its own whose sandbox runs no script;
- cut down first to what a message needs: scripts, frames, embedded objects,
  event handlers and anything that could redirect are taken out, and links
  open beside the mail without saying where they were followed from;
- under a policy written into the framed page that loads nothing from
  anywhere. Pictures kept on other sites are loaded only when you ask ("Show
  pictures"): loading one tells its sender that you opened the message.

Pictures that came with the message are shown. Attachments are saved, never
opened inside the page.

## Signing in

On the identity provider's own pages (OpenID Connect authorization code flow
with PKCE), through [`@mailless/web-session`](../../libs/web/session). Nothing
about the provider or the server is built in: the pages read where things are
from `/mail/config.json`.

The tokens are kept for as long as the tab is open, in memory and in the
tab's session storage, and are gone when it closes. A new tab signs in again,
which the provider's own session makes a matter of one click.

## Working on it

```sh
pnpm nx test webmail
pnpm nx build webmail
```

The tests run the whole page against a real mailless server over memory, so
what they show working is the page and the protocol together.

To run it on your own machine against a real deployment, allow sign-in to
come back to it (`webmail_extra_callback_urls = ["http://localhost:5174/mail/callback"]`
in `infra/terraform.tfvars`, then apply) and start it with the deployment as
its backend:

```sh
MAIL_BACKEND=https://mail.example.com pnpm nx dev webmail
```

The browser then sees one origin, so the API needs no CORS.

## How it reaches people

`pnpm nx build mailless-service` builds this app, packs the result into the
webmail function's bundle (`tools/embed-web.mjs`) and so deploys it with the
function: there is no bucket or CDN to keep in step.

## Not there yet

- A notification that says who wrote when no tab is open: that would mean
  the worker holding a sign-in of its own.
- Contacts, and suggestions while typing an address.
- Writing in rich text; messages are written as plain text.
- The mailboxes of other accounts shared with you.
- Renaming and removing mailboxes, and keyboard shortcuts.
