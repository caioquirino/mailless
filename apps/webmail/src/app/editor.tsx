import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html';
import {
  $isLinkNode,
  AutoLinkNode,
  LinkNode,
  TOGGLE_LINK_COMMAND,
} from '@lexical/link';
import {
  $isListNode,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  ListNode,
  REMOVE_LIST_COMMAND,
} from '@lexical/list';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
  HeadingNode,
  QuoteNode,
} from '@lexical/rich-text';
import { DRAG_DROP_PASTE } from '@lexical/rich-text';
import { $setBlocksType } from '@lexical/selection';
import { $findMatchingParent, $getNearestNodeOfType } from '@lexical/utils';
import {
  $createParagraphNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isDecoratorNode,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  FORMAT_TEXT_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type TextFormatType,
} from 'lexical';
import { Icon, IconButton, type IconName } from '@mailless/ui';
import { linkAddress, shortened } from '../lib/compose';
import { EMOJI, findEmoji, type Emoji } from '../lib/emoji';
import { usePreference } from '../lib/preference';
import {
  PictureNode,
  PictureProvider,
  PicturesPlugin,
  type PictureSource,
} from './pictures';

export interface EditorProps {
  /** What is in it to begin with. Only what the editor knows how to write is kept. */
  html: string;
  label: string;
  /** Whether the row of formatting buttons is shown. */
  tools: boolean;
  /** Whether to start with the cursor in it, at the top. */
  focused: boolean;
  /**
   * Where the editor puts the buttons of its own that belong with the
   * window's: the one for emoji. Nowhere, and there is no such button.
   */
  bar?: HTMLElement | null;
  /** The pictures among the words. Without it, the words hold none. */
  pictures?: PictureSource;
  onChange(html: string): void;
}

/** Marks no words carry: an editor's own, which mean nothing in a message. */
const THEME = {
  text: { underline: 'underlined' },
};

function fill(editor: LexicalEditor, html: string) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const root = $getRoot().clear();
  let loose: LexicalNode[] = [];
  const wrap = () => {
    if (loose.length === 0) return;
    root.append($createParagraphNode().append(...loose));
    loose = [];
  };
  // Words outside any paragraph get one: the top of a message holds only blocks.
  for (const node of $generateNodesFromDOM(editor, parsed)) {
    const block =
      ($isElementNode(node) || $isDecoratorNode(node)) && !node.isInline();
    if (block) {
      wrap();
      root.append(node);
    } else {
      loose.push(node);
    }
  }
  wrap();
  if (root.getChildrenSize() === 0) root.append($createParagraphNode());
}

/** Where words are written, with what a message can carry: emphasis, lists, quotes, links. */
export function Editor(props: EditorProps) {
  const { html, label, tools, focused, bar, pictures, onChange } = props;
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'mailless',
        theme: THEME,
        nodes: [
          HeadingNode,
          QuoteNode,
          ListNode,
          ListItemNode,
          LinkNode,
          AutoLinkNode,
          PictureNode,
        ],
        editorState: (editor) => fill(editor, html),
        onError: (error) => {
          throw error;
        },
      }}
    >
      <PictureProvider value={pictures ?? null}>
        <div className="editor">
          <RichTextPlugin
            contentEditable={
              <ContentEditable className="editor-text" aria-label={label} />
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <LinkBar />
          {tools ? <Tools /> : null}
        </div>
        <PicturesPlugin />
        {bar && pictures ? createPortal(<PictureButton />, bar) : null}
      </PictureProvider>
      <HistoryPlugin />
      <ListPlugin />
      <LinkPlugin validateUrl={(url) => linkAddress(url) !== null} />
      <OnChangePlugin
        ignoreSelectionChange
        onChange={(state, editor) =>
          onChange(state.read(() => $generateHtmlFromNodes(editor, null)))
        }
      />
      {focused ? <Focus /> : null}
      {bar ? createPortal(<EmojiPicker />, bar) : null}
    </LexicalComposer>
  );
}

function Focus() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.focus(undefined, { defaultSelection: 'rootStart' });
  }, [editor]);
  return null;
}

/** Chooses pictures to put among the words, for where nothing can be dragged. */
function PictureButton() {
  const [editor] = useLexicalComposerContext();
  return (
    <label className="icon-button" title="Insert a picture">
      <Icon name="picture" />
      <span className="visually-hidden">Insert a picture</span>
      <input
        type="file"
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="visually-hidden"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length > 0) editor.dispatchCommand(DRAG_DROP_PASTE, files);
        }}
      />
    </label>
  );
}

/** How many emoji used lately are kept at hand. */
const RECENT = 16;

/**
 * Emoji to put where the cursor is. They go in as the characters they are,
 * so a message carries them as text and any mail program shows them.
 */
function EmojiPicker() {
  const [editor] = useLexicalComposerContext();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [recent, setRecent] = usePreference<string>(
    'mailless.mail.emoji-recent',
    '',
  );
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const put = (emoji: Emoji) => {
    editor.update(() => {
      // Where the cursor was last; at the end, when it has not been in the words yet.
      if (!$isRangeSelection($getSelection())) $getRoot().selectEnd();
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText(emoji.char);
    });
    const kept = recent.split(' ').filter((char) => char !== '');
    setRecent(
      [emoji.char, ...kept.filter((char) => char !== emoji.char)]
        .slice(0, RECENT)
        .join(' '),
    );
  };
  const all = EMOJI.flatMap((group) => group.emoji);
  const lately = recent
    .split(' ')
    .map((char) => all.find((emoji) => emoji.char === char))
    .filter((emoji) => emoji !== undefined);
  const groups =
    typed.trim() !== ''
      ? [{ name: 'Found', emoji: findEmoji(typed) }]
      : [
          ...(lately.length > 0
            ? [{ name: 'Used lately', emoji: lately }]
            : []),
          ...EMOJI,
        ];

  return (
    <span className="emoji" ref={box}>
      <IconButton
        icon="emoji"
        label="Emoji"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open ? (
        <div
          className="emoji-panel"
          role="dialog"
          aria-label="Emoji"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <input
            autoFocus
            type="search"
            aria-label="Find an emoji"
            placeholder="Find an emoji"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            // Enter here is not the message being sent.
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
          <div className="emoji-groups">
            {groups.map((group) => (
              <section key={group.name} aria-label={group.name}>
                <h3>{group.name}</h3>
                {group.emoji.length === 0 ? (
                  <p className="muted small">Nothing by that name.</p>
                ) : (
                  <div className="emoji-grid">
                    {group.emoji.map((emoji) => (
                      <button
                        key={emoji.char}
                        type="button"
                        className="emoji-choice"
                        aria-label={emoji.name}
                        title={emoji.name}
                        // The cursor stays where the emoji is to go.
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => put(emoji)}
                      >
                        {emoji.char}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </span>
  );
}

interface AddressProps {
  /** What it starts as: the address a link has, or nothing for a new one. */
  from: string;
  done: string;
  onDone(url: string): void;
  onCancel(): void;
}

/**
 * Asks where a link leads. Not a form of its own: it sits inside the one
 * the message is written in, where Enter would otherwise send the message.
 */
function Address({ from, done, onDone, onCancel }: AddressProps) {
  const [address, setAddress] = useState(from);
  const [problem, setProblem] = useState(false);
  const finish = () => {
    const url = linkAddress(address);
    if (url === null) setProblem(true);
    else onDone(url);
  };
  const key = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Enter') finish();
    else onCancel();
  };
  return (
    <>
      <input
        autoFocus
        aria-label="Where the link leads"
        aria-invalid={problem}
        placeholder="https://example.com"
        value={address}
        onChange={(event) => {
          setAddress(event.target.value);
          setProblem(false);
        }}
        onKeyDown={key}
      />
      <button
        type="button"
        className="button button-small button-primary"
        onClick={finish}
      >
        {done}
      </button>
      <button type="button" className="button button-small" onClick={onCancel}>
        Cancel
      </button>
    </>
  );
}

interface Linked {
  key: string;
  url: string;
  top: number;
  left: number;
}

/**
 * What can be done with the link the cursor is in: follow it, which a click
 * on it does not do while it is being written, lead it somewhere else, or
 * make it plain words again.
 */
function LinkBar() {
  const [editor] = useLexicalComposerContext();
  const [link, setLink] = useState<Linked | null>(null);
  const [changing, setChanging] = useState(false);

  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        const found = editorState.read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
            return null;
          }
          const node = $findMatchingParent(
            selection.anchor.getNode(),
            $isLinkNode,
          );
          return $isLinkNode(node)
            ? { key: node.getKey(), url: node.getURL() }
            : null;
        });
        if (!found) {
          setLink(null);
          setChanging(false);
          return;
        }
        // Under the link, within the box the words are in.
        const box = editor.getElementByKey(found.key)?.getBoundingClientRect();
        const base = editor
          .getRootElement()
          ?.parentElement?.getBoundingClientRect();
        setLink((before) => {
          const next = {
            ...found,
            top: box && base ? Math.round(box.bottom - base.top) + 4 : 0,
            left:
              box && base ? Math.max(8, Math.round(box.left - base.left)) : 8,
          };
          const same =
            before !== null &&
            (Object.keys(next) as Array<keyof Linked>).every(
              (each) => before[each] === next[each],
            );
          return same ? before : next;
        });
      }),
    [editor],
  );

  if (!link) return null;
  const change = (url: string) => {
    editor.update(() => {
      const node = $getNodeByKey(link.key);
      if ($isLinkNode(node)) node.setURL(url);
    });
    setChanging(false);
  };
  const remove = () =>
    editor.update(() => {
      const node = $getNodeByKey(link.key);
      if (!$isLinkNode(node)) return;
      for (const child of node.getChildren()) node.insertBefore(child);
      node.remove();
    });
  return (
    <div
      className="link-bar"
      role="group"
      aria-label="Link"
      style={{ top: link.top, left: link.left }}
    >
      {changing ? (
        <Address
          from={link.url}
          done="Change the link"
          onDone={change}
          onCancel={() => setChanging(false)}
        />
      ) : (
        <>
          <span className="muted">Go to link:</span>
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            title={link.url}
          >
            {shortened(link.url)}
          </a>
          <span className="editor-gap" />
          <button
            type="button"
            className="link-bar-action"
            onClick={() => setChanging(true)}
          >
            Change
          </button>
          <span className="editor-gap" />
          <button type="button" className="link-bar-action" onClick={remove}>
            Remove
          </button>
        </>
      )}
    </div>
  );
}

type Block = 'paragraph' | 'heading' | 'quote' | 'bullet' | 'number';

interface Marks {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  link: boolean;
  block: Block;
}

const NO_MARKS: Marks = {
  bold: false,
  italic: false,
  underline: false,
  link: false,
  block: 'paragraph',
};

/** What the words under the cursor are, to show which buttons are on. */
function $marks(): Marks {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return NO_MARKS;
  const node = selection.anchor.getNode();
  const top = node.getKey() === 'root' ? node : node.getTopLevelElement();
  let block: Block = 'paragraph';
  if ($isListNode(top)) {
    const list = $getNearestNodeOfType(node, ListNode) ?? top;
    block = list.getListType() === 'number' ? 'number' : 'bullet';
  } else if ($isHeadingNode(top)) block = 'heading';
  else if ($isQuoteNode(top)) block = 'quote';
  const parent = node.getParent();
  return {
    bold: selection.hasFormat('bold'),
    italic: selection.hasFormat('italic'),
    underline: selection.hasFormat('underline'),
    link: $isLinkNode(parent) || $isLinkNode(node),
    block,
  };
}

function Tools() {
  const [editor] = useLexicalComposerContext();
  const [marks, setMarks] = useState(NO_MARKS);
  const [linking, setLinking] = useState(false);

  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) =>
        setMarks(editorState.read($marks)),
      ),
    [editor],
  );

  const format = (mark: TextFormatType) => () =>
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, mark);
  /** Makes the paragraphs under the cursor something else, or plain again when they already are it. */
  const block = (wanted: 'heading' | 'quote') => () =>
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      $setBlocksType(selection, () =>
        marks.block === wanted
          ? $createParagraphNode()
          : wanted === 'heading'
            ? $createHeadingNode('h3')
            : $createQuoteNode(),
      );
    });
  const list = (wanted: 'bullet' | 'number') => () =>
    editor.dispatchCommand(
      marks.block === wanted
        ? REMOVE_LIST_COMMAND
        : wanted === 'bullet'
          ? INSERT_UNORDERED_LIST_COMMAND
          : INSERT_ORDERED_LIST_COMMAND,
      undefined,
    );
  const plain = () =>
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      for (const node of selection.getNodes()) {
        if ($isTextNode(node)) node.setFormat(0);
      }
      $setBlocksType(selection, () => $createParagraphNode());
    });
  const link = () => {
    if (marks.link) editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
    else setLinking(true);
  };
  const tool = (
    icon: IconName,
    label: string,
    on: boolean,
    act: () => void,
  ) => (
    <button
      type="button"
      className="icon-button editor-tool"
      aria-label={label}
      title={label}
      aria-pressed={on}
      // The cursor stays in the words: these act on what is selected there.
      onMouseDown={(event) => event.preventDefault()}
      onClick={act}
    >
      <Icon name={icon} />
    </button>
  );

  if (linking) {
    return (
      <div className="editor-tools editor-link">
        <Address
          from=""
          done="Add the link"
          onDone={(url) => {
            editor.dispatchCommand(TOGGLE_LINK_COMMAND, url);
            setLinking(false);
          }}
          onCancel={() => setLinking(false)}
        />
      </div>
    );
  }
  return (
    <div className="editor-tools" role="toolbar" aria-label="Formatting">
      {tool('bold', 'Bold', marks.bold, format('bold'))}
      {tool('italic', 'Italic', marks.italic, format('italic'))}
      {tool('underline', 'Underline', marks.underline, format('underline'))}
      <span className="editor-gap" />
      {tool('heading', 'Heading', marks.block === 'heading', block('heading'))}
      {tool('list', 'Bulleted list', marks.block === 'bullet', list('bullet'))}
      {tool(
        'numbered',
        'Numbered list',
        marks.block === 'number',
        list('number'),
      )}
      {tool('quote', 'Quote', marks.block === 'quote', block('quote'))}
      <span className="editor-gap" />
      {tool('link', marks.link ? 'Remove the link' : 'Link', marks.link, link)}
      {tool('plain', 'Remove formatting', false, plain)}
    </div>
  );
}
