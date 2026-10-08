import { useEffect, useRef, useState, type FormEvent } from 'react';
import { JmapRequestError } from '@mailless/jmap-client';
import { formatAddresses, parseAddresses } from '../lib/addresses';
import { swapSignature } from '../lib/compose';
import { formatSize } from '../lib/format';
import { MailError, type Attachment, type Draft } from '../lib/mail';
import { useMail, useServices, useSynced } from './services';

export interface ComposeProps {
  draft: Draft;
  onClose(): void;
}

/** A message being written: who to, what about, what it says, what goes with it. */
export function Compose({ draft, onClose }: ComposeProps) {
  const { client } = useServices();
  const { store, act, say } = useMail();
  useSynced(store.identities);
  const identities = store.identities.values();

  const [identityId, setIdentityId] = useState(draft.identityId);
  const [to, setTo] = useState(formatAddresses(draft.to));
  const [cc, setCc] = useState(formatAddresses(draft.cc));
  const [bcc, setBcc] = useState(formatAddresses(draft.bcc));
  const [others, setOthers] = useState(draft.cc.length + draft.bcc.length > 0);
  const [subject, setSubject] = useState(draft.subject);
  const [text, setText] = useState(draft.text);
  const [attachments, setAttachments] = useState<Attachment[]>(
    draft.attachments,
  );
  /** The copy kept on the server, which the next one kept or sent replaces. */
  const [kept, setKept] = useState(draft.replaces);
  const [busy, setBusy] = useState<'sending' | 'saving' | 'attaching' | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);

  // An answer starts where the words go, above what is quoted; a new message with who it is for.
  useEffect(() => {
    if (draft.to.length > 0) {
      body.current?.focus();
      body.current?.setSelectionRange(0, 0);
    } else {
      first.current?.focus();
    }
  }, [draft]);

  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setChanged(true);
      setProblem(null);
    };

  /** What is in the form as a message, or null with the problem shown. */
  const written = (): Draft | null => {
    const lines = { To: to, Cc: cc, Bcc: bcc };
    const parsed = Object.fromEntries(
      Object.entries(lines).map(([name, line]) => [name, parseAddresses(line)]),
    );
    for (const [name, result] of Object.entries(parsed)) {
      if (result.invalid !== undefined) {
        setProblem(`“${result.invalid}” in ${name} is not an address.`);
        return null;
      }
    }
    return {
      ...draft,
      identityId,
      to: parsed['To']?.addresses ?? [],
      cc: parsed['Cc']?.addresses ?? [],
      bcc: parsed['Bcc']?.addresses ?? [],
      subject: subject.trim(),
      text,
      attachments,
      ...(kept ? { replaces: kept } : {}),
    };
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const message = written();
    if (!message) return;
    if (message.to.length + message.cc.length + message.bcc.length === 0) {
      setProblem('Say who the message is for.');
      first.current?.focus();
      return;
    }
    setBusy('sending');
    try {
      await store.send(message);
      say('Message sent');
      onClose();
    } catch (error) {
      setProblem(
        error instanceof MailError
          ? error.message
          : 'The message could not be sent. Check your connection and try again.',
      );
      setBusy(null);
    }
  };

  const save = async (): Promise<boolean> => {
    const message = written();
    if (!message) return false;
    setBusy('saving');
    try {
      setKept(await store.saveDraft(message));
      setChanged(false);
      say('Draft kept');
      return true;
    } catch (error) {
      setProblem(
        error instanceof MailError
          ? error.message
          : 'The draft could not be kept. Check your connection and try again.',
      );
      return false;
    } finally {
      setBusy(null);
    }
  };

  const attach = async (chosen: FileList | null) => {
    if (!chosen || chosen.length === 0) return;
    setBusy('attaching');
    setProblem(null);
    for (const file of [...chosen]) {
      try {
        const type = file.type || 'application/octet-stream';
        const uploaded = await client.upload(file, { type });
        setAttachments((current) => [
          ...current,
          { blobId: uploaded.blobId, name: file.name, type, size: file.size },
        ]);
        setChanged(true);
      } catch (error) {
        setProblem(
          error instanceof JmapRequestError && error.status === 413
            ? `${file.name} is too large to attach.`
            : `${file.name} could not be attached.`,
        );
        break;
      }
    }
    if (files.current) files.current.value = '';
    setBusy(null);
  };

  const close = () => {
    if (changed) setLeaving(true);
    else onClose();
  };
  const discard = async () => {
    if (kept) {
      // The copy that was kept goes too: discarding means there is nothing left of it.
      await act(() => store.destroy([kept]));
    }
    onClose();
  };

  return (
    <section className="compose" role="dialog" aria-label="Write a message">
      <header className="compose-head">
        <h2>{draft.answers ? 'Answer' : 'New message'}</h2>
        <button type="button" className="button button-small" onClick={close}>
          Close
        </button>
      </header>
      <form className="compose-form" onSubmit={(event) => void send(event)}>
        {identities.length > 1 ? (
          <label className="field">
            <span>From</span>
            <select
              value={identityId}
              onChange={(event) => {
                // Signed as whoever it is now from.
                setText(
                  swapSignature(
                    text,
                    store.identities.get(identityId),
                    store.identities.get(event.target.value),
                  ),
                );
                edit(setIdentityId)(event.target.value);
              }}
            >
              {identities.map((identity) => (
                <option key={identity.id} value={identity.id}>
                  {identity.name
                    ? `${identity.name} <${identity.email}>`
                    : identity.email}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="field">
          <span>To</span>
          <input
            ref={first}
            value={to}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => edit(setTo)(event.target.value)}
          />
          {others ? null : (
            <button
              type="button"
              className="button button-small button-quiet"
              onClick={() => setOthers(true)}
            >
              Cc, Bcc
            </button>
          )}
        </label>
        {others ? (
          <>
            <label className="field">
              <span>Cc</span>
              <input
                value={cc}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => edit(setCc)(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Bcc</span>
              <input
                value={bcc}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => edit(setBcc)(event.target.value)}
              />
            </label>
          </>
        ) : null}
        <label className="field">
          <span>Subject</span>
          <input
            value={subject}
            maxLength={500}
            onChange={(event) => edit(setSubject)(event.target.value)}
          />
        </label>
        <textarea
          ref={body}
          className="compose-text"
          aria-label="Message"
          value={text}
          onChange={(event) => edit(setText)(event.target.value)}
        />
        {attachments.length > 0 ? (
          <ul className="attachments" aria-label="Attached">
            {attachments.map((attachment, index) => (
              <li key={`${attachment.blobId}-${index}`} className="attached">
                <span className="attachment-name">{attachment.name}</span>
                <span className="muted small">
                  {formatSize(attachment.size)}
                </span>
                <button
                  type="button"
                  className="button button-small button-quiet"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() =>
                    edit(setAttachments)(
                      attachments.filter((_, each) => each !== index),
                    )
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {problem ? (
          <p className="notice notice-error" role="alert">
            {problem}
          </p>
        ) : null}
        {leaving ? (
          <div
            className="notice notice-warning"
            role="alertdialog"
            aria-label="Close the message"
          >
            <p>Keep what you have written as a draft?</p>
            <div className="row">
              <button
                type="button"
                className="button button-small button-primary"
                disabled={busy !== null}
                onClick={() =>
                  void save().then((saved) => {
                    if (saved) onClose();
                    else setLeaving(false);
                  })
                }
              >
                Keep as a draft
              </button>
              <button
                type="button"
                className="button button-small button-danger"
                disabled={busy !== null}
                onClick={() => void discard()}
              >
                Discard
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={() => setLeaving(false)}
              >
                Go on writing
              </button>
            </div>
          </div>
        ) : (
          <div className="row compose-actions">
            <button
              type="submit"
              className="button button-primary"
              disabled={busy !== null}
            >
              {busy === 'sending' ? 'Sending…' : 'Send'}
            </button>
            <button
              type="button"
              className="button"
              disabled={busy !== null}
              onClick={() => void save()}
            >
              {busy === 'saving' ? 'Keeping…' : 'Keep as a draft'}
            </button>
            <label className={`button${busy ? ' disabled' : ''}`}>
              {busy === 'attaching' ? 'Attaching…' : 'Attach files'}
              <input
                ref={files}
                type="file"
                multiple
                className="visually-hidden"
                disabled={busy !== null}
                onChange={(event) => void attach(event.target.files)}
              />
            </label>
          </div>
        )}
      </form>
    </section>
  );
}
