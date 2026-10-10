# webmail

The mailless webmail: a React application served under `/mail/`, next to the
JMAP API it is a client of.

- **Mailboxes** with what is unread in each, and new ones made on the spot.
- **Conversations**: one row for each, newest first; read, archive, delete,
  move, flag, several at a time; the trash and junk emptied in one go.
- **Reading**: each message of a conversation, its attachments saved to disk.
- **Writing**: new messages, answers and forwards, in a window that docks in
  the corner, folds down to its title or takes the whole page (on a phone it
  always takes the screen). Rich text, written with
  [Lexical](https://lexical.dev): emphasis, headings, lists, quotes and links,
  sent as a page and as plain words. Emoji, as characters every mail program
  shows. Pictures among the words: dropped, pasted or chosen, then sized,
  dragged elsewhere or taken out, and sent as parts of the message that the
  words point at. Who it is for as chips. What is answered
  stays under the words exactly as it came, behind a button, and is never
  put through the editor. Attachments up to what the server will send (a
  large one is uploaded in pieces), by choosing, dropping or pasting them.
  Sending can wait: a few seconds after Send, in which "Undo" takes the
  message back (how long is a setting), or until a time chosen beside Send.
  The server does the waiting, so a message goes when its time comes whether
  or not this page is open, and until then it says where it is filed that it
  has not gone, with a button to stop it.
  Who it is for is suggested while typing, from the address book and from
  who was written to before. Up to three messages can be open at once, one
  in front and the others down to their titles. An answer or a forward
  takes along the pictures the original shows in place.
  What is written is kept as a draft by itself a moment after the last
  change, and closing the window loses nothing.
- **Contacts**: the address book, beside the mail. Everyone in it under the
  letter their name starts with, searched by anything their card says; one
  person at a time, with how to reach them, a button to write to each
  address, and the mail there has been with them; a form to add someone or
  change them, with a photo. Whoever wrote a message is added from the
  message. Kept as cards other programs read too (JSContact, over JMAP).
  The photo kept of someone is beside their mail too, and one's own, chosen
  in the settings, stands for one's own. Nothing is fetched from anywhere
  to put a face to mail: only pictures the user put there are shown.
- **Search** through everything, narrowed two ways that are one: typed, with
  words such as `from:`, `has:attachment` or `newer:1m` (people are offered
  while one is being named), or filled in as a form. Either changes the
  other, and what narrows a search is shown in the bar, each to be taken out
  by itself.

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

In a browser tab, the tokens are kept for as long as the tab is open, in
memory and in the tab's session storage, and are gone when it closes. A new
tab signs in again, which the provider's own session makes a matter of one
click for a while.

Installed on a device (the browser's "Install"), closing the application is
only putting it away, so the tokens are kept on the device until signing out,
and it opens on the mail. The provider gives a new refresh token at each
renewal and takes the old one back, signing out takes the last one back too,
and after 30 days it asks to sign in again whatever happened in between.

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
- Bringing contacts in from a file, or out to one; and sharing an address book.
- While writing: templates,
  and how far
  an attachment has got while it uploads.
- The mailboxes of other accounts shared with you.
- Renaming and removing mailboxes, and keyboard shortcuts.
