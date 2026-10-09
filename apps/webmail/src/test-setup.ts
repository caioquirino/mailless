import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// How long something is waited for before it is said not to be there: a second
// is not enough where the tests of everything else run at the same time.
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

// jsdom has no digests; the browser's are the same ones Node has.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
}

// jsdom's <dialog> cannot be opened as a browser's can.
if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

// What the editor asks of a browser that jsdom has not got: where the cursor
// is on the page, and the event of something dragged over it.
const nowhere = () =>
  ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    width: 0,
    height: 0,
  }) as DOMRect;
Range.prototype.getBoundingClientRect ??= nowhere;
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
globalThis.DragEvent ??= class extends MouseEvent {} as typeof DragEvent;
globalThis.ClipboardEvent ??= class extends Event {
  clipboardData: DataTransfer | null = null;
} as typeof ClipboardEvent;
// With this the editor takes what is typed as a browser gives it, before the
// page changes, which is the only way it is given here.
InputEvent.prototype.getTargetRanges ??= () => [];

// jsdom does not hand out addresses for what is held in memory.
let made = 0;
URL.createObjectURL ??= () => `blob:test-${++made}`;
URL.revokeObjectURL ??= () => undefined;
