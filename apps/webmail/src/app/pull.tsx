import { useRef, useState, type TouchEvent } from 'react';
import { Icon } from '@mailless/ui';

/** How far down, in pixels, the mark has to be drawn for letting go to mean something. */
const FAR_ENOUGH = 64;
/** Where the mark stops following the finger. */
const FURTHEST = 96;
/** How much of the finger's way the mark goes: it is drawn against a pull. */
const GIVE = 0.5;

/** Whether everything between what was touched and the page is at its top. */
function atTop(touched: EventTarget, within: Element): boolean {
  let each = touched instanceof Element ? touched : null;
  while (each) {
    if (each.scrollTop > 0) return false;
    if (each === within) break;
    each = each.parentElement;
  }
  return true;
}

/** Whether what was touched is being written in: a finger drawn there moves the cursor. */
function written(touched: EventTarget): boolean {
  return (
    touched instanceof Element &&
    touched.closest('input, textarea, select, [contenteditable="true"]') !==
      null
  );
}

export interface Pull {
  /** How far the mark is drawn, in pixels. */
  drawn: number;
  /** Whether letting go now would bring the mail up to date. */
  ready: boolean;
  /** Whether the mail is being brought up to date. */
  working: boolean;
  /** What to listen with, on what is pulled. */
  touch: {
    onTouchStart(event: TouchEvent): void;
    onTouchMove(event: TouchEvent): void;
    onTouchEnd(): void;
    onTouchCancel(): void;
  };
}

/**
 * Pulling the page down from its top, on a screen that is touched: where a
 * browser would load the page again, this asks only for what changed.
 */
export function usePull(sync: () => Promise<unknown>): Pull {
  const [drawn, setDrawn] = useState(0);
  const [working, setWorking] = useState(false);
  const from = useRef<{ x: number; y: number } | null>(null);
  const far = useRef(0);

  const draw = (distance: number) => {
    far.current = distance;
    setDrawn(distance);
  };
  const drop = () => {
    from.current = null;
    draw(0);
  };

  return {
    drawn,
    ready: drawn >= FAR_ENOUGH,
    working,
    touch: {
      onTouchStart(event) {
        const [finger] = Array.from(event.touches);
        from.current =
          working ||
          event.touches.length !== 1 ||
          !finger ||
          written(event.target) ||
          !atTop(event.target, event.currentTarget)
            ? null
            : { x: finger.clientX, y: finger.clientY };
      },
      onTouchMove(event) {
        const [finger] = Array.from(event.touches);
        if (!from.current || !finger) return;
        const down = finger.clientY - from.current.y;
        const across = Math.abs(finger.clientX - from.current.x);
        // Upwards, sideways, or over something that scrolled meanwhile: not a pull.
        if (
          down <= 0 ||
          (far.current === 0 && across > down) ||
          !atTop(event.target, event.currentTarget)
        ) {
          drop();
          return;
        }
        draw(Math.min(FURTHEST, down * GIVE));
      },
      onTouchEnd() {
        const enough = from.current !== null && far.current >= FAR_ENOUGH;
        drop();
        if (!enough) return;
        setWorking(true);
        void sync().finally(() => setWorking(false));
      },
      onTouchCancel: drop,
    },
  };
}

/** What comes down with a pull, and turns while the mail is brought up to date. */
export function PullMark({ pull }: { pull: Pull }) {
  const { drawn, ready, working } = pull;
  if (drawn === 0 && !working) return null;
  return (
    <div
      className={`pull-mark${ready ? ' pull-ready' : ''}${
        working ? ' pull-working' : ''
      }`}
      role={working ? 'status' : undefined}
      aria-hidden={working ? undefined : true}
      style={{
        transform: `translate(-50%, ${working ? FAR_ENOUGH : drawn}px)`,
        opacity: working ? 1 : Math.min(1, drawn / FAR_ENOUGH),
      }}
    >
      <span
        className="pull-icon"
        style={working ? undefined : { transform: `rotate(${drawn * 3}deg)` }}
      >
        <Icon name="refresh" size={20} />
      </span>
      {working ? (
        <span className="visually-hidden">Checking for new mail…</span>
      ) : null}
    </div>
  );
}
