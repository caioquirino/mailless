import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router';
import { Button, Icon, IconButton } from '@mailless/ui';
import type { Id } from '@mailless/jmap-core';
import {
  FIELDS,
  HOWS,
  headActs,
  scriptOf,
  summaryOf,
  worded,
  type Action,
  type Block,
  type Condition,
  type Field,
  type Filters,
  type How,
  type Rule,
  type Trial,
} from '../lib/filters';
import type { MailStore } from '../lib/mail';
import { orderMailboxes } from '../lib/mailboxes';
import { useMail, useServices, useSynced, withUndo } from './services';

/** How many of the latest messages a filter is tried on. */
const TRIED = 200;

/** A message a filter is tried on: enough to say which it is, and to put it back as it was. */
interface Sample {
  id: Id;
  blobId: Id;
  from: Array<{ name: string | null; email: string }> | null;
  subject: string | null;
  receivedAt: string;
  mailboxIds: Record<Id, boolean>;
  keywords: Record<string, boolean>;
}

type Doing =
  | { kind: 'form'; at: number | null; rule: Rule }
  | { kind: 'script' }
  | { kind: 'remove'; at: number }
  | null;

const several = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count} ${many}`;

/** What the folders and tags of a filter are called here. */
export function useFilterNames(store: MailStore) {
  useSynced(store.mailboxes);
  useSynced(store.tags.made);
  return useMemo(() => {
    const folders = orderMailboxes(store.mailboxes.values());
    const path = (id: Id): string | undefined => {
      const at = folders.findIndex((each) => each.mailbox.id === id);
      const found = folders[at];
      if (!found) return undefined;
      const names = [found.mailbox.name];
      let depth = found.depth;
      for (let index = at - 1; index >= 0 && depth > 0; index--) {
        const above = folders[index];
        if (above && above.depth < depth) {
          names.unshift(above.mailbox.name);
          depth = above.depth;
        }
      }
      return names.join('/');
    };
    const tags = store.tags.all().filter((tag) => tag.fixed !== 'starred');
    return {
      folders: folders.map(({ mailbox }) => ({
        id: mailbox.id,
        name: path(mailbox.id) ?? mailbox.name,
      })),
      tags,
      folder: (id: Id, name: string) => path(id) ?? `${name} (gone)`,
      tag: (keyword: string) =>
        tags.find((tag) => tag.keyword === keyword.toLowerCase())?.name ??
        keyword,
    };
    // Asked again when the folders or the tags have changed.
  }, [store, store.mailboxes.version, store.tags.made.version]);
}

type Names = ReturnType<typeof useFilterNames>;

/** What a script would do with a message, in words. */
export function told(trial: Trial, names: Names): string {
  if (trial.discarded) return 'thrown away';
  const marks = trial.flags.map((flag) => {
    const lower = flag.toLowerCase();
    return lower === '\\seen' || lower === '$seen'
      ? 'marked read'
      : lower === '\\flagged' || lower === '$flagged'
        ? 'starred'
        : `tagged ${names.tag(flag)}`;
  });
  const where =
    trial.folders.length > 0
      ? trial.folders
          .map((folder, index) =>
            names.folder(trial.mailboxIds[index] ?? '', folder),
          )
          .join(' and ')
      : 'left where it is';
  return [where, ...marks].join(', ');
}

/** The latest messages, to try a filter on. */
async function latest(
  client: ReturnType<typeof useServices>['client'],
): Promise<Sample[]> {
  const { ids } = (await client.call('Email/query', {
    sort: [{ property: 'receivedAt', isAscending: false }],
    limit: TRIED,
  } as never)) as unknown as { ids: Id[] };
  if (ids.length === 0) return [];
  const got = (await client.call('Email/get', {
    ids,
    properties: [
      'blobId',
      'from',
      'subject',
      'receivedAt',
      'mailboxIds',
      'keywords',
    ],
  } as never)) as unknown as { list: Sample[] };
  // Latest first, as they were asked for.
  const order = new Map(ids.map((id, index) => [id, index]));
  return [...got.list].sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
}

/** What is done with mail as it arrives, in the settings. */
export function FilterSetting() {
  const { store, act, say } = useMail();
  const filters = store.filters;
  useSynced(filters);
  const names = useFilterNames(store);
  const location = useLocation();
  const [ready, setReady] = useState(false);
  const [doing, setDoing] = useState<Doing>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    void filters.start().then(
      () => current && setReady(true),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [filters]);
  // Come from a message, to make a filter for those like it.
  const asked = (location.state as { filter?: Rule } | null)?.filter;
  useEffect(() => {
    if (asked && ready) setDoing({ kind: 'form', at: null, rule: asked });
  }, [asked, ready]);

  if (!ready || !filters.available) return null;
  const all = filters.filters;
  const keep = async (next: Filters, done: string) => {
    setBusy(true);
    const worked = await act(() => filters.saveFilters(next));
    setBusy(false);
    if (worked) {
      setDoing(null);
      say(done);
    }
    return worked;
  };
  const withBlocks = (blocks: Block[]): Filters => ({ ...all, blocks });
  const moved = (at: number, by: number) => {
    const blocks = [...all.blocks];
    const [block] = blocks.splice(at, 1);
    if (block) blocks.splice(at + by, 0, block);
    return withBlocks(blocks);
  };

  if (doing?.kind === 'script') {
    return (
      <ScriptEditor
        names={names}
        onDone={(saved) => {
          setDoing(null);
          if (saved) say('The filters were saved');
        }}
      />
    );
  }
  if (doing?.kind === 'form') {
    return (
      <FilterForm
        start={doing.rule}
        names={names}
        taken={all.blocks
          .filter((_, index) => index !== doing.at)
          .map((each) => each.name.trim().toLowerCase())}
        scriptWith={(rule) =>
          scriptOf({ head: all.head, blocks: [blockOf(rule)] })
        }
        busy={busy}
        onCancel={() => setDoing(null)}
        onSave={async (rule, now) => {
          const blocks = [...all.blocks];
          const block = {
            ...blockOf(rule),
            on: doing.at === null ? true : (blocks[doing.at]?.on ?? true),
          };
          if (doing.at === null) blocks.push(block);
          else blocks[doing.at] = block;
          const worked = await keep(
            withBlocks(blocks),
            `The filter ${rule.name} was saved`,
          );
          if (worked && now.length > 0) await applyNow(rule, now);
        }}
      />
    );
  }

  /** Does to messages that are here already what a filter would have done to them. */
  async function applyNow(rule: Rule, samples: Sample[]) {
    const { client } = store;
    const patch: Record<string, unknown> = {};
    for (const action of rule.actions) {
      if (action.kind === 'move')
        patch['mailboxIds'] = { [action.mailboxId]: true };
      else {
        const keyword =
          action.kind === 'tag'
            ? action.keyword.toLowerCase()
            : action.kind === 'read'
              ? '$seen'
              : '$flagged';
        patch[`keywords/${keyword}`] = true;
      }
    }
    const set = (update: Record<Id, unknown>) =>
      client.call('Email/set', { update } as never).then(() => store.refresh());
    const worked = await act(() =>
      set(Object.fromEntries(samples.map((each) => [each.id, patch]))),
    );
    if (!worked) return;
    say(
      `Done to ${several(samples.length, 'message', 'messages')} you already had`,
      withUndo({ act, say }, () =>
        set(
          Object.fromEntries(
            samples.map((each) => [
              each.id,
              { mailboxIds: each.mailboxIds, keywords: each.keywords },
            ]),
          ),
        ),
      ),
    );
  }

  return (
    <section className="setting" aria-labelledby="setting-filters">
      <div className="folders-head">
        <div>
          <h2 id="setting-filters">Filters</h2>
          <p className="muted">
            What to do with mail as it arrives. They are tried from the top;
            each one that fits is done, unless one says to stop. They run on the
            server, so it is the same on every device.
          </p>
        </div>
        <Button
          variant="primary"
          icon="plus"
          disabled={busy}
          onClick={() =>
            setDoing({
              kind: 'form',
              at: null,
              rule: {
                name: '',
                any: false,
                conditions: [{ field: 'from', how: 'contains', value: '' }],
                actions: [],
                stop: false,
              },
            })
          }
        >
          New filter
        </Button>
      </div>
      {headActs(all.head) ? (
        <p className="notice small">
          The script does things before the first filter. They are written by
          hand, and changed in the script.
        </p>
      ) : null}
      {all.blocks.length === 0 ? (
        <p className="muted small">
          There are no filters: mail goes to the Inbox.
        </p>
      ) : (
        <ul className="folders filters" aria-label="Filters">
          {all.blocks.map((block, at) => {
            const summary = block.rule ? summaryOf(block.rule, names) : null;
            return (
              <li key={`${at}-${block.name}`}>
                <div
                  className={`folder filter${block.on ? '' : ' filter-off'}`}
                >
                  <span className="filter-order">
                    <IconButton
                      icon="chevron-up"
                      label={`Move ${block.name} up`}
                      disabled={busy || at === 0}
                      onClick={() =>
                        void keep(
                          moved(at, -1),
                          `${block.name} is tried earlier`,
                        )
                      }
                    />
                    <IconButton
                      icon="chevron-down"
                      label={`Move ${block.name} down`}
                      disabled={busy || at === all.blocks.length - 1}
                      onClick={() =>
                        void keep(moved(at, 1), `${block.name} is tried later`)
                      }
                    />
                  </span>
                  <label className="filter-on">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={block.on}
                      disabled={busy}
                      onChange={() =>
                        void keep(
                          withBlocks(
                            all.blocks.map((each, index) =>
                              index === at ? { ...each, on: !each.on } : each,
                            ),
                          ),
                          `${block.name} is ${block.on ? 'off' : 'on'}`,
                        )
                      }
                    />
                    <span className="visually-hidden">{block.name} is on</span>
                  </label>
                  <span className="folder-name filter-what">
                    <strong>{block.name || '(no name)'}</strong>
                    {summary ? (
                      <span className="muted small">
                        If {summary.when} → {summary.then}
                      </span>
                    ) : (
                      <>
                        <span className="filter-hand small">
                          written by hand
                        </span>
                        <code className="filter-source muted small">
                          {block.source.split('\n')[0]}
                        </code>
                      </>
                    )}
                  </span>
                  <IconButton
                    icon={block.rule ? 'write' : 'format'}
                    label={
                      block.rule
                        ? `Change ${block.name}`
                        : `Change ${block.name} in the script`
                    }
                    disabled={busy}
                    onClick={() =>
                      setDoing(
                        block.rule
                          ? { kind: 'form', at, rule: block.rule }
                          : { kind: 'script' },
                      )
                    }
                  />
                  <IconButton
                    icon="delete"
                    label={`Delete ${block.name}`}
                    disabled={busy}
                    onClick={() => setDoing({ kind: 'remove', at })}
                  />
                </div>
                {doing?.kind === 'remove' && doing.at === at ? (
                  <div
                    className="notice notice-warning confirm"
                    role="alertdialog"
                    aria-label={`Delete ${block.name}`}
                  >
                    <p>
                      Delete the filter “{block.name}”? Mail it already filed
                      stays where it is.
                    </p>
                    <div className="row">
                      <Button
                        size="small"
                        variant="danger"
                        disabled={busy}
                        onClick={() =>
                          void keep(
                            withBlocks(
                              all.blocks.filter((_, index) => index !== at),
                            ),
                            `${block.name} was deleted`,
                          )
                        }
                      >
                        Delete the filter
                      </Button>
                      <Button size="small" onClick={() => setDoing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small filter-script-line">
        All of this is one Sieve script. A filter the form cannot show is
        “written by hand”: it is switched and ordered here, and changed in the
        script.{' '}
        <Button
          size="small"
          disabled={busy}
          onClick={() => setDoing({ kind: 'script' })}
        >
          Edit as a script
        </Button>
      </p>
    </section>
  );
}

const blockOf = (rule: Rule): Block => ({
  name: rule.name.trim(),
  on: true,
  source: '',
  rule: { ...rule, name: rule.name.trim() },
});

/** What is wrong with a filter as filled in; null when it can be kept. */
function ruleProblem(rule: Rule, taken: readonly string[]): string | null {
  const name = rule.name.trim();
  if (name === '') return 'Give the filter a name.';
  if (/[[\]]/.test(name)) return 'A name cannot have [ or ] in it.';
  if (taken.includes(name.toLowerCase())) {
    return 'Another filter has this name.';
  }
  if (
    rule.conditions.some((each) => worded(each.field) && !each.value.trim())
  ) {
    return 'Say what each condition looks for.';
  }
  if (rule.actions.length === 0 && !rule.stop) {
    return 'Say what the filter does.';
  }
  return null;
}

function FilterForm(props: {
  start: Rule;
  names: Names;
  /** The names other filters have, in small letters. */
  taken: readonly string[];
  /** The script that is this filter alone, to try it by. */
  scriptWith(rule: Rule): string;
  busy: boolean;
  onCancel(): void;
  /** `now` are the messages already here to do the same to. */
  onSave(rule: Rule, now: Sample[]): void | Promise<void>;
}) {
  const { names } = props;
  const { client } = useServices();
  const { store, act } = useMail();
  const [rule, setRule] = useState(props.start);
  const [trial, setTrial] = useState<{ of: string; hits: Sample[] } | null>(
    null,
  );
  const [trying, setTrying] = useState(false);
  const [also, setAlso] = useState(false);
  const problem = ruleProblem(rule, props.taken);
  const script = problem ? '' : props.scriptWith(rule);
  // What was tried is of the filter as it was then.
  const fresh = trial !== null && trial.of === script;
  const set = (change: Partial<Rule>) => setRule({ ...rule, ...change });
  const setCondition = (at: number, change: Partial<Condition>) =>
    set({
      conditions: rule.conditions.map((each, index) =>
        index === at ? { ...each, ...change } : each,
      ),
    });
  const setAction = (at: number, action: Action) =>
    set({
      actions: rule.actions.map((each, index) =>
        index === at ? action : each,
      ),
    });
  const actionOf = (kind: Action['kind']): Action | null =>
    kind === 'move'
      ? names.folders[0]
        ? {
            kind,
            mailboxId: names.folders[0].id,
            name: names.folders[0].name,
          }
        : null
      : kind === 'tag'
        ? names.tags[0]
          ? { kind, keyword: names.tags[0].keyword }
          : null
        : { kind };
  const tryIt = async () => {
    setTrying(true);
    await act(async () => {
      const samples = await latest(client);
      const trials = await store.filters.tryOn(
        script,
        samples.map((each) => each.blobId),
      );
      setTrial({
        of: script,
        hits: samples.filter(
          (each) => (trials.get(each.blobId)?.rules.length ?? 0) > 0,
        ),
      });
    });
    setTrying(false);
  };

  return (
    <section className="setting" aria-labelledby="setting-filter">
      <form
        className="filter-form"
        aria-label="Filter"
        onSubmit={(event) => {
          event.preventDefault();
          if (problem || props.busy) return;
          void props.onSave(rule, also && fresh ? trial.hits : []);
        }}
      >
        <div className="folders-head">
          <h2 id="setting-filter">Filter</h2>
          <span className="row">
            <Button onClick={props.onCancel}>Cancel</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={props.busy || problem !== null}
            >
              Save
            </Button>
          </span>
        </div>
        <div className="filter-columns">
          <div className="filter-fields">
            <label className="filter-row">
              <span className="muted small filter-label">Name</span>
              <input
                value={rule.name}
                maxLength={80}
                autoFocus
                onChange={(event) => set({ name: event.target.value })}
              />
            </label>
            <h3 className="filter-part">When a message arrives and</h3>
            <div className="filter-row">
              <select
                aria-label="How many must fit"
                value={rule.any ? 'any' : 'all'}
                onChange={(event) => set({ any: event.target.value === 'any' })}
              >
                <option value="all">all of these</option>
                <option value="any">any of these</option>
              </select>
              <span className="muted small">
                {rule.any ? 'is true' : 'are true'}
              </span>
            </div>
            {rule.conditions.map((condition, at) => (
              <div className="filter-row" key={at}>
                <select
                  aria-label={`Condition ${at + 1}: what`}
                  value={condition.field}
                  onChange={(event) =>
                    setCondition(at, {
                      field: event.target.value as Field,
                      value: event.target.value === 'larger' ? '10' : '',
                    })
                  }
                >
                  {FIELDS.map((each) => (
                    <option key={each.field} value={each.field}>
                      {each.label}
                    </option>
                  ))}
                </select>
                {worded(condition.field) ? (
                  <>
                    <select
                      aria-label={`Condition ${at + 1}: how`}
                      value={condition.how}
                      onChange={(event) =>
                        setCondition(at, { how: event.target.value as How })
                      }
                    >
                      {HOWS.map((each) => (
                        <option key={each.how} value={each.how}>
                          {each.label}
                        </option>
                      ))}
                    </select>
                    <input
                      className="filter-value"
                      aria-label={`Condition ${at + 1}: value`}
                      value={condition.value}
                      maxLength={200}
                      onChange={(event) =>
                        setCondition(at, { value: event.target.value })
                      }
                    />
                  </>
                ) : condition.field === 'larger' ? (
                  <>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      aria-label={`Condition ${at + 1}: megabytes`}
                      value={condition.value}
                      onChange={(event) =>
                        setCondition(at, { value: event.target.value })
                      }
                    />
                    <span className="muted small">MB</span>
                    <span className="filter-value" />
                  </>
                ) : (
                  <span className="filter-value" />
                )}
                <IconButton
                  icon="close"
                  label={`Remove condition ${at + 1}`}
                  onClick={() =>
                    set({
                      conditions: rule.conditions.filter(
                        (_, index) => index !== at,
                      ),
                    })
                  }
                />
              </div>
            ))}
            <button
              type="button"
              className="filter-more"
              onClick={() =>
                set({
                  conditions: [
                    ...rule.conditions,
                    { field: 'subject', how: 'contains', value: '' },
                  ],
                })
              }
            >
              <Icon name="plus" size={14} /> Another condition
            </button>
            <h3 className="filter-part">Do this</h3>
            {rule.actions.map((action, at) => (
              <div className="filter-row" key={at}>
                <select
                  aria-label={`Action ${at + 1}`}
                  value={action.kind}
                  onChange={(event) => {
                    const next = actionOf(event.target.value as Action['kind']);
                    if (next) setAction(at, next);
                  }}
                >
                  <option value="move">Move to the folder</option>
                  <option value="tag">Add the tag</option>
                  <option value="read">Mark read</option>
                  <option value="star">Star</option>
                </select>
                {action.kind === 'move' ? (
                  <select
                    className="filter-value"
                    aria-label={`Action ${at + 1}: folder`}
                    value={action.mailboxId}
                    onChange={(event) =>
                      setAction(at, {
                        kind: 'move',
                        mailboxId: event.target.value,
                        name:
                          names.folders.find(
                            (each) => each.id === event.target.value,
                          )?.name ?? '',
                      })
                    }
                  >
                    {names.folders.some(
                      (each) => each.id === action.mailboxId,
                    ) ? null : (
                      <option value={action.mailboxId}>
                        {action.name} (gone)
                      </option>
                    )}
                    {names.folders.map((each) => (
                      <option key={each.id} value={each.id}>
                        {each.name}
                      </option>
                    ))}
                  </select>
                ) : action.kind === 'tag' ? (
                  <select
                    className="filter-value"
                    aria-label={`Action ${at + 1}: tag`}
                    value={action.keyword.toLowerCase()}
                    onChange={(event) =>
                      setAction(at, {
                        kind: 'tag',
                        keyword: event.target.value,
                      })
                    }
                  >
                    {names.tags.some(
                      (each) => each.keyword === action.keyword.toLowerCase(),
                    ) ? null : (
                      <option value={action.keyword.toLowerCase()}>
                        {action.keyword}
                      </option>
                    )}
                    {names.tags.map((each) => (
                      <option key={each.id} value={each.keyword}>
                        {each.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="filter-value" />
                )}
                <IconButton
                  icon="close"
                  label={`Remove action ${at + 1}`}
                  onClick={() =>
                    set({
                      actions: rule.actions.filter((_, index) => index !== at),
                    })
                  }
                />
              </div>
            ))}
            <button
              type="button"
              className="filter-more"
              onClick={() => {
                const next =
                  actionOf(
                    rule.actions.some((each) => each.kind === 'move')
                      ? 'tag'
                      : 'move',
                  ) ?? actionOf('read');
                if (next) set({ actions: [...rule.actions, next] });
              }}
            >
              <Icon name="plus" size={14} /> Another action
            </button>
            <label className="filter-stop">
              <input
                type="checkbox"
                checked={rule.stop}
                onChange={(event) => set({ stop: event.target.checked })}
              />
              <span>
                <strong>Then stop</strong>{' '}
                <span className="muted small">
                  · the filters below this one are not tried
                </span>
              </span>
            </label>
            {problem ? <p className="muted small">{problem}</p> : null}
          </div>
          <aside className="filter-trial" aria-label="What it would have done">
            <Button
              icon="refresh"
              disabled={trying || problem !== null}
              onClick={() => void tryIt()}
            >
              {trying ? 'Trying…' : `Try it on your last ${TRIED} messages`}
            </Button>
            {fresh ? (
              <>
                <p className="small">
                  <strong>{trial.hits.length}</strong>{' '}
                  <span className="muted">
                    would have been caught. Nothing has been touched.
                  </span>
                </p>
                <ul className="filter-hits">
                  {trial.hits.slice(0, 6).map((each) => (
                    <li key={each.id} className="small">
                      <strong>
                        {each.from?.[0]?.name || each.from?.[0]?.email || '?'}
                      </strong>
                      <span>{each.subject || '(no subject)'}</span>
                    </li>
                  ))}
                </ul>
                {trial.hits.length > 6 ? (
                  <p className="muted small">
                    and {trial.hits.length - 6} more
                  </p>
                ) : null}
                {trial.hits.length > 0 && rule.actions.length > 0 ? (
                  <label className="filter-stop">
                    <input
                      type="checkbox"
                      checked={also}
                      onChange={(event) => setAlso(event.target.checked)}
                    />
                    <span>
                      <strong>
                        Also do it to these {trial.hits.length} now
                      </strong>
                      <br />
                      <span className="muted small">
                        Once, when you save. It can be undone.
                      </span>
                    </span>
                  </label>
                ) : null}
              </>
            ) : (
              <p className="muted small">
                See what the filter would have caught before you save it. Trying
                changes nothing.
              </p>
            )}
          </aside>
        </div>
      </form>
    </section>
  );
}

function ScriptEditor(props: { names: Names; onDone(saved: boolean): void }) {
  const { names } = props;
  const { client } = useServices();
  const { store, act } = useMail();
  const filters = store.filters;
  const [text, setText] = useState(
    () => filters.script || scriptOf({ head: '', blocks: [] }),
  );
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ problem: string } | { fine: true } | null>(
    null,
  );
  const [tried, setTried] = useState<Array<{
    sample: Sample;
    trial: Trial;
  }> | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    await act(action);
    setBusy(false);
  };
  const check = () =>
    run(async () => {
      const problem = await filters.check(text);
      setSaid(problem ? { problem } : { fine: true });
    });
  const tryIt = () =>
    run(async () => {
      const problem = await filters.check(text);
      if (problem) {
        setSaid({ problem });
        setTried(null);
        return;
      }
      setSaid(null);
      const samples = await latest(client);
      const trials = await filters.tryOn(
        text,
        samples.map((each) => each.blobId),
      );
      setTried(
        samples.flatMap((sample) => {
          const trial = trials.get(sample.blobId);
          return trial ? [{ sample, trial }] : [];
        }),
      );
    });
  const save = () =>
    run(async () => {
      const problem = await filters.check(text);
      if (problem) {
        setSaid({ problem });
        return;
      }
      await filters.save(text);
      props.onDone(true);
    });
  const counts = new Map<string, number>();
  for (const { trial } of tried ?? []) {
    for (const name of trial.rules.length > 0 ? trial.rules : ['no filter']) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const caught = (tried ?? []).filter((each) => each.trial.rules.length > 0);

  return (
    <section className="setting" aria-labelledby="setting-script">
      <div className="folders-head">
        <div>
          <h2 id="setting-script">Filters, as a script</h2>
          <p className="muted">
            Each filter is a block under a line with its name:{' '}
            <code># rule:[Name]</code>. Saved, a block the form can show is a
            filter you can change in the form again; one it cannot is kept as
            written, and marked “written by hand” in the list.
          </p>
        </div>
        <span className="row">
          <Button onClick={() => props.onDone(false)}>Cancel</Button>
          <Button disabled={busy} onClick={() => void check()}>
            Check
          </Button>
          <Button disabled={busy} onClick={() => void tryIt()}>
            Try it
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            Save
          </Button>
        </span>
      </div>
      <div className="filter-columns">
        <div className="filter-fields">
          <textarea
            className="filter-script"
            aria-label="The script"
            spellCheck={false}
            rows={Math.min(28, Math.max(12, text.split('\n').length + 1))}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setSaid(null);
            }}
          />
          {said && 'problem' in said ? (
            <p className="notice notice-error small" role="alert">
              {said.problem}. It cannot be tried or saved until the script is
              right; the one in use goes on working.
            </p>
          ) : said ? (
            <p className="notice small" role="status">
              The script is right.
            </p>
          ) : null}
        </div>
        {tried ? (
          <aside
            className="filter-trial"
            aria-label="Tried, and nothing touched"
          >
            <p className="small">
              <strong>
                Tried on your last{' '}
                {several(tried.length, 'message', 'messages')}
              </strong>
              <br />
              <span className="muted">
                Nothing has been touched: this is what would happen.
              </span>
            </p>
            <p className="filter-counts">
              {[...counts.entries()].map(([name, count]) => (
                <span key={name} className="filter-count small">
                  {name} <strong>{count}</strong>
                </span>
              ))}
            </p>
            <ul className="filter-hits">
              {caught.slice(0, 8).map(({ sample, trial }) => (
                <li key={sample.id} className="small">
                  <strong>
                    {sample.from?.[0]?.name || sample.from?.[0]?.email || '?'}
                  </strong>
                  <span>{sample.subject || '(no subject)'}</span>
                  <span className="muted">
                    → {told(trial, names)} · <em>{trial.rules.join(', ')}</em>
                  </span>
                </li>
              ))}
            </ul>
            {caught.length > 8 ? (
              <p className="muted small">and {caught.length - 8} more</p>
            ) : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
