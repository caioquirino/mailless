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
import { ANSWER_WORDS, AnswerButtons } from './event-editor';
import { useMail, useSynced } from './services';

/** Whether something that came with a message is a calendar file. */
const isCalendarFile = (part: { type?: string; name?: string | null }) =>
  part.type === 'text/calendar' ||
  part.type === 'application/ics' ||
  /\.ics$/i.test(part.name ?? '');

function when(invitation: Invitation): string {
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
  useEffect(() => {
    setInvitation(null);
    setGiven(null);
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
      {week}
    </div>
  );
}
