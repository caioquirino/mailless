import {
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { EmailAddress } from '@mailless/jmap-core';
import { Avatar, Icon } from '@mailless/ui';
import { nameOf, parseAddresses } from '../lib/addresses';
import type { Person } from '../lib/people';

/*
 * Who something is for: a message, or an event. Each a chip, with a place to
 * type the next, and under it who what is typed might be the start of.
 */

/** People a message is for, and what is being typed after the last of them. */
export interface People {
  list: EmailAddress[];
  typing: string;
}

export const people = (list: EmailAddress[]): People => ({ list, typing: '' });

/** What is typed, read as addresses. Null when some of it is not one. */
export function typed(text: string): EmailAddress[] | null {
  if (text.trim() === '') return [];
  return parseAddresses(text).addresses ?? null;
}

interface RecipientsProps {
  /** What its field is known by on the page, which no other field is. */
  id: string;
  label: string;
  value: People;
  /** Who what is typed might be the start of. */
  suggest(typed: string): Person[];
  input?: RefObject<HTMLInputElement | null>;
  onChange(value: People): void;
  /** For where it stands outside a message being written, to be laid out as that place needs. */
  className?: string;
  children?: ReactNode;
}

/** A line of who a message is for: each a chip, and a place to type the next. */
export function Recipients(props: RecipientsProps) {
  const { id, label, value, input, onChange, suggest, children } = props;
  /** Which of the people suggested is marked, and whether they are shown at all. */
  const [marked, setMarked] = useState(0);
  const [hidden, setHidden] = useState(false);
  const suggested = hidden ? [] : suggest(value.typing);
  const at = Math.min(marked, suggested.length - 1);

  /** Turns what is typed into people, when all of it is addresses. */
  const settle = (text: string): boolean => {
    const added = typed(text);
    if (added === null) return false;
    if (added.length > 0 || text !== value.typing) {
      onChange({ list: [...value.list, ...added], typing: '' });
    }
    return true;
  };
  const take = (person: Person) => {
    onChange({ list: [...value.list, person], typing: '' });
    setMarked(0);
  };
  const type = (text: string) => {
    setHidden(false);
    setMarked(0);
    // A comma ends an address: what is before the last one becomes people.
    const end = Math.max(text.lastIndexOf(','), text.lastIndexOf(';'));
    const added = end < 0 ? null : typed(text.slice(0, end));
    if (added === null) onChange({ ...value, typing: text.trimStart() });
    else {
      onChange({
        list: [...value.list, ...added],
        typing: text.slice(end + 1).trimStart(),
      });
    }
  };
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    const person = suggested[at];
    if (person && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setMarked((at + step + suggested.length) % suggested.length);
    } else if (person && event.key === 'Escape') {
      event.stopPropagation();
      setHidden(true);
    } else if (
      person &&
      (event.key === 'Enter' || event.key === 'Tab') &&
      // An address typed out in full is the one meant, whoever else begins like it.
      !(typed(value.typing)?.length === 1)
    ) {
      event.preventDefault();
      take(person);
    } else if (event.key === 'Enter' && value.typing.trim() !== '') {
      event.preventDefault();
      settle(value.typing);
    } else if (event.key === 'Backspace' && value.typing === '') {
      onChange({ ...value, list: value.list.slice(0, -1) });
    }
  };
  return (
    <div
      className={`compose-row${props.className ? ` ${props.className}` : ''}`}
    >
      <label htmlFor={id}>{label}</label>
      <ul className="chips" aria-label={`${label}: people`}>
        {value.list.map((person, index) => (
          <li key={`${person.email}-${index}`} className="chip">
            <Avatar name={nameOf(person)} size="small" />
            <span className="chip-name" title={person.email}>
              {nameOf(person)}
            </span>
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${nameOf(person)}`}
              onClick={() =>
                onChange({
                  ...value,
                  list: value.list.filter((_, each) => each !== index),
                })
              }
            >
              <Icon name="close" size={12} />
            </button>
          </li>
        ))}
        <li className="chip-input">
          <input
            id={id}
            ref={input}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggested.length > 0}
            aria-controls={`${id}-people`}
            aria-activedescendant={
              suggested.length > 0 ? `${id}-person-${at}` : undefined
            }
            value={value.typing}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => type(event.target.value)}
            onKeyDown={key}
            onBlur={() => {
              settle(value.typing);
              setHidden(true);
            }}
          />
        </li>
      </ul>
      {children}
      {suggested.length > 0 ? (
        <ul
          className="suggestions"
          id={`${id}-people`}
          role="listbox"
          aria-label={`${label}: suggestions`}
        >
          {suggested.map((person, index) => (
            <li
              key={person.email}
              id={`${id}-person-${index}`}
              role="option"
              aria-selected={index === at}
              className="suggestion"
              // Pressed with the cursor still in the field, which leaving would settle.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => take(person)}
            >
              <Avatar name={nameOf(person)} size="small" />
              <span className="suggestion-who">
                <span className="suggestion-name">{nameOf(person)}</span>
                {person.name ? (
                  <span className="muted small">{person.email}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
