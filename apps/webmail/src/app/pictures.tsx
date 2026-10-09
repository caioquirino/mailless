import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { DRAG_DROP_PASTE } from '@lexical/rich-text';
import { mergeRegister } from '@lexical/utils';
import {
  $createRangeSelection,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  DRAGOVER_COMMAND,
  DRAGSTART_COMMAND,
  DROP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  type DOMConversionMap,
  type DOMExportOutput,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { isPicture } from '../lib/compose';

/*
 * Pictures among the words of a message. Each goes with the message as a
 * part of it, and the words point at it by an id of its own (its "cid"),
 * which is how every mail program shows a picture in its place. Here it is
 * shown from the copy this browser has of it.
 */

/** Where the pictures of the message being written come from, and go to. */
export interface PictureSource {
  /** An address this page can show the picture from, once it is here. */
  url(cid: string): string | undefined;
  /** Takes a picture into the message, and says what it is known by. Fails when it cannot. */
  add(file: File): Promise<{ cid: string; name: string }>;
}

const Source = createContext<PictureSource | null>(null);
export const PictureProvider = Source.Provider;

/** How wide a picture is made at most when it is put in, in pixels: what fits a message. */
export const BEST_FIT = 560;
const SMALL = 240;
const NARROWEST = 32;

/** What a picture being moved within the words is carried as. */
const MOVING = 'application/x-mailless-picture';

interface PictureFields {
  cid: string;
  alt: string;
  /** In pixels. Null is as wide as the picture is. */
  width: number | null;
}

type SerializedPicture = Spread<PictureFields, SerializedLexicalNode>;

export class PictureNode extends DecoratorNode<JSX.Element> {
  __cid: string;
  __alt: string;
  __width: number | null;

  static override getType(): string {
    return 'picture';
  }

  static override clone(node: PictureNode): PictureNode {
    return new PictureNode(
      { cid: node.__cid, alt: node.__alt, width: node.__width },
      node.__key,
    );
  }

  constructor(fields: PictureFields, key?: NodeKey) {
    super(key);
    this.__cid = fields.cid;
    this.__alt = fields.alt;
    this.__width = fields.width;
  }

  static override importJSON(
    serialized: Parameters<typeof DecoratorNode.importJSON>[0],
  ): PictureNode {
    const fields = serialized as Partial<PictureFields>;
    return $createPictureNode({
      cid: fields.cid ?? '',
      alt: fields.alt ?? '',
      width: fields.width ?? null,
    });
  }

  override exportJSON(): SerializedPicture {
    return {
      ...super.exportJSON(),
      cid: this.__cid,
      alt: this.__alt,
      width: this.__width,
    };
  }

  /** Only a picture that came with the message: one kept elsewhere is not taken in. */
  static override importDOM(): DOMConversionMap {
    return {
      img: (element: HTMLElement) =>
        (element.getAttribute('src') ?? '').startsWith('cid:')
          ? {
              priority: 1,
              conversion: (image: HTMLElement) => ({
                node: $createPictureNode({
                  cid: (image.getAttribute('src') ?? '').slice('cid:'.length),
                  alt: image.getAttribute('alt') ?? '',
                  width: Number(image.getAttribute('width')) || null,
                }),
              }),
            }
          : null,
    };
  }

  override exportDOM(): DOMExportOutput {
    const element = document.createElement('img');
    element.setAttribute('src', `cid:${this.__cid}`);
    element.setAttribute('alt', this.__alt);
    if (this.__width !== null) {
      element.setAttribute('width', String(this.__width));
    }
    return { element };
  }

  override createDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'picture';
    return element;
  }

  override updateDOM(): false {
    return false;
  }

  override isInline(): true {
    return true;
  }

  setWidth(width: number | null): void {
    this.getWritable().__width = width;
  }

  override decorate(): JSX.Element {
    return (
      <PictureView
        nodeKey={this.__key}
        cid={this.__cid}
        alt={this.__alt}
        width={this.__width}
      />
    );
  }
}

export function $createPictureNode(fields: PictureFields): PictureNode {
  return new PictureNode({
    cid: fields.cid,
    alt: fields.alt,
    width: fields.width,
  });
}

export function $isPictureNode(
  node: LexicalNode | null | undefined,
): node is PictureNode {
  return node instanceof PictureNode;
}

interface PictureViewProps extends PictureFields {
  nodeKey: NodeKey;
}

/** A picture as it is written with: pressed to choose it, then sized, moved or taken out. */
function PictureView({ nodeKey, cid, alt, width }: PictureViewProps) {
  const [editor] = useLexicalComposerContext();
  const source = useContext(Source);
  const [selected, setSelected, clearSelection] =
    useLexicalNodeSelection(nodeKey);
  const image = useRef<HTMLImageElement>(null);
  /** How wide the picture itself is, once the browser has it. */
  const [natural, setNatural] = useState<number | null>(null);
  /** How wide it is being pulled to, while its corner is held. */
  const [pulled, setPulled] = useState<number | null>(null);
  const url = source?.url(cid);

  const resize = (next: number | null) =>
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isPictureNode(node)) node.setWidth(next);
    });
  const remove = () =>
    editor.update(() => {
      $getNodeByKey(nodeKey)?.remove();
    });

  useEffect(() => {
    const drop = (event: KeyboardEvent) => {
      if (!selected || !$isNodeSelection($getSelection())) return false;
      event.preventDefault();
      $getNodeByKey(nodeKey)?.remove();
      return true;
    };
    return mergeRegister(
      editor.registerCommand(
        CLICK_COMMAND,
        (event) => {
          if (event.target !== image.current) return false;
          if (!event.shiftKey) clearSelection();
          setSelected(true);
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        DRAGSTART_COMMAND,
        (event) => {
          if (event.target !== image.current) return false;
          event.dataTransfer?.setData(MOVING, nodeKey);
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(KEY_DELETE_COMMAND, drop, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_BACKSPACE_COMMAND, drop, COMMAND_PRIORITY_LOW),
    );
  }, [editor, nodeKey, selected, setSelected, clearSelection]);

  /** Pulling the corner makes it wider or narrower; its height follows. */
  const pull = (event: ReactPointerEvent) => {
    event.preventDefault();
    const from = event.clientX;
    const before = image.current?.getBoundingClientRect().width || width || 0;
    const most = editor.getRootElement()?.clientWidth || 4000;
    const at = (x: number) =>
      Math.round(Math.min(most, Math.max(NARROWEST, before + x - from)));
    const move = (moved: PointerEvent) => setPulled(at(moved.clientX));
    const release = (released: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      setPulled(null);
      resize(at(released.clientX));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release, { once: true });
  };

  const sizes: Array<[string, number | null]> = [
    ['Small', Math.min(natural ?? SMALL, SMALL)],
    ['Best fit', Math.min(natural ?? BEST_FIT, BEST_FIT)],
    ['Original size', natural],
  ];
  const shown = pulled ?? width;

  if (!url) {
    return <span className="picture-waiting">{alt || 'Picture'}…</span>;
  }
  return (
    <span className={`picture-box${selected ? ' selected' : ''}`}>
      <img
        ref={image}
        src={url}
        alt={alt}
        {...(shown === null ? {} : { width: shown })}
        draggable
        onLoad={(event) => {
          const wide = event.currentTarget.naturalWidth;
          if (wide > 0) setNatural(wide);
          // Put in as wide as fits a message, when it is wider than that.
          if (width === null && wide > BEST_FIT) resize(BEST_FIT);
        }}
      />
      {selected ? (
        <>
          <span
            className="picture-handle"
            aria-hidden="true"
            onPointerDown={pull}
          />
          <span
            className="picture-bar"
            role="group"
            aria-label={`Picture: ${alt || 'no name'}`}
            // Pressing these leaves the picture chosen.
            onMouseDown={(event) => event.preventDefault()}
          >
            {sizes.map(([label, size]) => (
              <button
                key={label}
                type="button"
                className="link-bar-action"
                aria-pressed={size === width}
                onClick={() => resize(size)}
              >
                {label}
              </button>
            ))}
            <span className="editor-gap" />
            <button type="button" className="link-bar-action" onClick={remove}>
              Remove
            </button>
          </span>
        </>
      ) : null}
    </span>
  );
}

/** Where in the words a point on the screen is. */
function rangeAt(event: DragEvent): Range | null {
  const page = document as Document & {
    caretRangeFromPoint?(x: number, y: number): Range | null;
    caretPositionFromPoint?(
      x: number,
      y: number,
    ): { offsetNode: Node; offset: number } | null;
  };
  if (page.caretRangeFromPoint) {
    return page.caretRangeFromPoint(event.clientX, event.clientY);
  }
  const position = page.caretPositionFromPoint?.(event.clientX, event.clientY);
  if (!position) return null;
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}

/**
 * Takes pictures that are dropped or pasted on the words into the message,
 * where the cursor is, and lets one that is already there be dragged to
 * somewhere else in them.
 */
export function PicturesPlugin() {
  const [editor] = useLexicalComposerContext();
  const source = useContext(Source);

  useEffect(() => {
    const put = async (files: File[]) => {
      for (const file of files) {
        let added;
        try {
          added = await source?.add(file);
        } catch {
          // Said by whoever could not take it.
          return;
        }
        if (!added) return;
        const { cid, name } = added;
        editor.update(() => {
          if (!$isRangeSelection($getSelection())) $getRoot().selectEnd();
          $insertNodes([$createPictureNode({ cid, alt: name, width: null })]);
        });
      }
    };
    return mergeRegister(
      editor.registerCommand(
        DRAG_DROP_PASTE,
        (files) => {
          const pictures = files.filter(isPicture);
          if (pictures.length === 0 || !source) return false;
          void put(pictures);
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        DRAGOVER_COMMAND,
        (event) => {
          if (!event.dataTransfer?.types.includes(MOVING)) return false;
          event.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        DROP_COMMAND,
        (event) => {
          const key = event.dataTransfer?.getData(MOVING);
          if (!key) return false;
          event.preventDefault();
          const node = $getNodeByKey(key);
          const range = rangeAt(event);
          if (!$isPictureNode(node) || !range) return true;
          const there = $createRangeSelection();
          there.applyDOMRange(range);
          node.remove();
          $setSelection(there);
          $insertNodes([node]);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }, [editor, source]);
  return null;
}
