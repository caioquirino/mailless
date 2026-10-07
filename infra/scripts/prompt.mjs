// Reading a secret from the terminal, or from a pipe when there is no terminal.
import { createInterface } from 'node:readline';

/**
 * Reads a line from the terminal, showing a `*` for each character so that
 * typing and pasting are visibly received without revealing the text.
 */
function askHidden(prompt, input = process.stdin, output = process.stdout) {
  return new Promise((resolve, reject) => {
    let value = '';
    let pending = '';
    output.write(prompt);
    input.setRawMode(true);
    input.resume();

    const finish = (action) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      output.write('\n');
      action();
    };

    const onData = (chunk) => {
      // Terminals may wrap a paste in these markers; they are not part of the password.
      pending += chunk.toString('utf8').replace(/\u001b\[20[01]~/g, '');
      // Wait for the rest of an escape sequence that was split across chunks.
      if (/\u001b(\[[0-9;]*)?$/.test(pending)) return;
      const text = pending.replace(/\u001b\[[0-9;]*[A-Za-z~]/g, '');
      pending = '';

      for (const character of text) {
        if (character === '\r' || character === '\n') {
          finish(() => resolve(value));
          return;
        }
        if (character === '\u0003') {
          finish(() => reject(new Error('Cancelled. Nothing was changed.')));
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length > 0) {
            value = [...value].slice(0, -1).join('');
            output.write('\b \b');
          }
        } else if (character === '\u0015') {
          output.write('\b \b'.repeat([...value].length));
          value = '';
        } else if (character >= ' ') {
          value += character;
          output.write('*');
        }
      }
    };
    input.on('data', onData);
  });
}

/** Reads one line when the password is piped in rather than typed. */
function readPipedLine() {
  return new Promise((resolve) => {
    const readline = createInterface({ input: process.stdin });
    let answered = false;
    readline.once('line', (line) => {
      answered = true;
      readline.close();
      resolve(line);
    });
    readline.once('close', () => {
      if (!answered) resolve('');
    });
  });
}

/** A secret typed at a masked prompt, or the first line of piped input. */
export function readSecret(prompt) {
  return process.stdin.isTTY ? askHidden(prompt) : readPipedLine();
}
