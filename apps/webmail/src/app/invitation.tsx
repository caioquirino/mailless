import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Email } from '@mailless/jmap-core';
import {
  dayKey,
  organizerOf,
  ownEntry,
  shown,
  timeOf,
  type Answer,
  type Invitation,
} from '../lib/calendar';
import { ANSWER_WORDS, AnswerButtons, ProposeForm } from './event-editor';
import { useMail, useSynced } from './services';

/** Whether something that came with a message is a calendar file. */
const isCalendarFile = (part: { type?: string; name?: string | null }) =>
  part.type === 'text/calendar' ||
  part.type === 'application/ics' ||
  /\.ics$/i.test(part.name ?? '');

function when(invitation: Parameters<typeof shown>[0]): string {
  const { start, end, allDay } = shown(invitation);
  const day = (date: Date) =>
    date.toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  if (allDay) return day(start);
  return `${day(start)}, ${timeOf(start)} – ${timeOf(end)}`;
}

/**
 * What a message says of a calendar, above the message: an invitation, with
 * the three answers to give to it; word that an event is off; or what
 * someone answered. The event is read from the file that came with it.
 */
export function InvitationCard({ email }: { email: Email }) {
  const { store, act, say } = useMail();
  const calendar = store.calendar;
  useSynced(calendar.events);
  const blobId = (email.attachments ?? []).find(isCalendarFile)?.blobId;
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  /** What was answered here, until the calendar says the same. */
  const [given, setGiven] = useState<Answer | null>(null);
  /** Whether another time is being written out, and whether a suggested one is about to be taken up. */
  const [proposing, setProposing] = useState(false);
  const [taking, setTaking] = useState(false);
  /** What was done about a suggestion, once something was. */
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    setInvitation(null);
    setGiven(null);
    setProposing(false);
    setTaking(false);
    setSettled(null);
    if (!blobId) return undefined;
    let current = true;
    calendar
      .start()
      .then(() => calendar.parse(blobId))
      .then(
        (found) => current && setInvitation(found),
        // A file that cannot be read is still there to open, among what came with the message.
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [calendar, blobId]);
  if (!invitation) return null;

  const known = calendar.known(invitation);
  const organizer = organizerOf(invitation);
  const mine = ownEntry(known ?? invitation, calendar.own);
  const theirs =
    organizer !== null &&
    !calendar.own.some((each) => each.email.toLowerCase() === organizer);
  const place = Object.values(invitation.locations ?? {})[0]?.name;
  const what = (
    <span className="invitation-what">
      <strong>{invitation.title?.trim() || '(no title)'}</strong>
      <span>{when(invitation)}</span>
      {place ? <span className="muted small">{place}</span> : null}
    </span>
  );
  const week = (
    <Link
      className="small"
      to={`/calendar/week/${dayKey(shown(invitation).start)}`}
    >
      See that week
    </Link>
  );

  if (invitation.method === 'cancel' || invitation.status === 'cancelled') {
    return (
      <div className="invitation invitation-off" role="note">
        {what}
        <span className="muted">This event was cancelled.</span>
      </div>
    );
  }
  if (invitation.method === 'declinecounter') {
    return (
      <div className="invitation" role="note">
        {what}
        <span>{organizer ?? 'Whoever invited'} is keeping this time.</span>
        {week}
      </div>
    );
  }
  if (invitation.method === 'counter') {
    // Someone suggests another time for an event. What the file says is when it would be.
    const from = email.from?.[0]?.email.toLowerCase() ?? '';
    const suggested = shown(invitation);
    const asked =
      known !== undefined &&
      !theirs &&
      Object.values(known.participants ?? {}).some(
        (each) => each.email?.toLowerCase() === from,
      );
    const there =
      known !== undefined &&
      shown(known).start.getTime() === suggested.start.getTime() &&
      shown(known).end.getTime() === suggested.end.getTime();
    const run = async (action: () => Promise<unknown>, done: string) => {
      setBusy(true);
      const worked = await act(action);
      setBusy(false);
      setTaking(false);
      if (!worked) return;
      setSettled(done);
      say(done);
    };
    return (
      <div
        className="invitation invitation-suggestion"
        role="note"
        aria-label="Another time suggested"
      >
        <span className="invitation-what">
          <span className="muted small">
            {from || 'Someone'} suggests another time for
          </span>
          <strong>
            {invitation.title?.trim() || known?.title || '(no title)'}
          </strong>
          <span>{when(invitation)}</span>
          {known && !there ? (
            <span className="muted small">As it stands: {when(known)}</span>
          ) : null}
          {invitation.comment ? (
            <span className="invitation-comment">“{invitation.comment}”</span>
          ) : null}
        </span>
        {settled ? (
          <span className="muted">{settled}</span>
        ) : there ? (
          <span className="muted">The event is at this time.</span>
        ) : !asked || !known ? (
          <span className="muted small">
            {known
              ? 'Whoever the event is from decides.'
              : 'This event is not in your calendar.'}
          </span>
        ) : taking ? (
          <span
            className="invitation-ask"
            role="alertdialog"
            aria-label="Tell the others?"
          >
            <span>Send the new time to the people on it?</span>
            <button
              type="button"
              className="button button-small"
              disabled={busy}
              onClick={() => setTaking(false)}
            >
              Back
            </button>
            <button
              type="button"
              className="button button-small"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    calendar.takeUp(
                      known,
                      suggested.start,
                      suggested.end,
                      false,
                    ),
                  'The event was moved. Nobody was told.',
                )
              }
            >
              Don’t send
            </button>
            <button
              type="button"
              className="button button-small button-primary"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    calendar.takeUp(
                      known,
                      suggested.start,
                      suggested.end,
                      true,
                    ),
                  'The event was moved, and the people on it were told.',
                )
              }
            >
              Send
            </button>
          </span>
        ) : (
          <span className="answer-buttons">
            <button
              type="button"
              className="button button-small button-primary"
              disabled={busy}
              onClick={() => setTaking(true)}
            >
              Use this time
            </button>
            {calendar.proposals ? (
              <button
                type="button"
                className="button button-small"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => calendar.keepTime(known.id, from),
                    `${from} was told the time is kept.`,
                  )
                }
              >
                Keep the time
              </button>
            ) : null}
          </span>
        )}
        {week}
      </div>
    );
  }
  if (invitation.method === 'reply') {
    const from = email.from?.[0]?.email.toLowerCase();
    const answer = Object.values(invitation.participants ?? {}).find(
      (each) => each.email?.toLowerCase() === from,
    )?.participationStatus;
    return (
      <div className="invitation" role="note">
        {what}
        <span>
          {from ?? 'Someone'} answered:{' '}
          <strong>
            {(ANSWER_WORDS[answer ?? ''] ?? 'something else').toLowerCase()}
          </strong>
        </span>
        {week}
      </div>
    );
  }
  // An invitation, or a file with an event in it and nobody to answer to.
  const answer = given ?? mine?.[1].participationStatus ?? 'needs-action';
  const respond = async (reply: Answer) => {
    setBusy(true);
    const told = await act(() => calendar.respond(invitation, reply));
    setBusy(false);
    if (!told) return;
    setGiven(reply);
    say(
      `${organizer ?? 'They'} was told: ${ANSWER_WORDS[reply]?.toLowerCase()}. It is in your calendar.`,
    );
  };
  /** Suggests another time. It has to be in the calendar to be spoken of: answered "maybe" when it was not answered yet. */
  const suggest = async (start: Date, end: Date, comment: string) => {
    setBusy(true);
    const sent = await act(async () => {
      if (!calendar.known(invitation)) {
        await calendar.respond(invitation, 'tentative');
      }
      const event = calendar.known(invitation);
      if (!event)
        throw new Error('The event could not be put in your calendar.');
      await calendar.propose(event.id, start, end, comment);
    });
    setBusy(false);
    if (!sent) return;
    setProposing(false);
    if (answer === 'needs-action') setGiven('tentative');
    say(`${organizer ?? 'They'} was sent your suggestion`);
  };
  return (
    <div className="invitation" role="note" aria-label="Invitation">
      {what}
      {theirs && mine ? (
        <AnswerButtons
          answer={answer}
          busy={busy}
          onAnswer={(reply) => void respond(reply)}
        />
      ) : null}
      {theirs && mine && calendar.proposals && !proposing ? (
        <button
          type="button"
          className="button button-small"
          disabled={busy}
          onClick={() => setProposing(true)}
        >
          Suggest another time
        </button>
      ) : null}
      {week}
      {proposing ? (
        <ProposeForm
          start={shown(invitation).start}
          end={shown(invitation).end}
          busy={busy}
          onCancel={() => setProposing(false)}
          onSend={(start, end, comment) => void suggest(start, end, comment)}
        />
      ) : null}
    </div>
  );
}
