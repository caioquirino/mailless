import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Avatar,
  Button,
  IconButton,
  Notice,
  Tag,
  Theme,
  ThemeSwitch,
  toneOf,
} from '../index.js';

describe('Button', () => {
  it('is a button that does not submit a form unless told to', () => {
    render(
      <>
        <Button>Plain</Button>
        <Button variant="primary" size="small" wide icon="write" type="submit">
          Write
        </Button>
      </>,
    );
    const plain = screen.getByRole('button', { name: 'Plain' });
    expect(plain).toHaveAttribute('type', 'button');
    expect(plain).toHaveClass('button');
    const write = screen.getByRole('button', { name: 'Write' });
    expect(write).toHaveAttribute('type', 'submit');
    expect(write).toHaveClass(
      'button',
      'button-primary',
      'button-small',
      'button-wide',
    );
    // The icon is decoration: the words say what the button does.
    expect(write.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('IconButton', () => {
  it('always says what it does, and whether what it switches is on', async () => {
    const pressed = vi.fn();
    render(
      <>
        <IconButton icon="archive" label="Archive" onClick={pressed} />
        <IconButton icon="flag" label="Flag" pressed />
      </>,
    );
    const archive = screen.getByRole('button', { name: 'Archive' });
    expect(archive).toHaveAttribute('title', 'Archive');
    expect(archive).not.toHaveAttribute('aria-pressed');
    await userEvent.click(archive);
    expect(pressed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Flag' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('Avatar', () => {
  it('gives the same name the same colour, and shows its initial', () => {
    const { container } = render(
      <>
        <Avatar name="marta Lindqvist" />
        <Avatar name="Marta Lindqvist " size="large" />
        <Avatar name="" />
      </>,
    );
    const [first, second, empty] = [...container.querySelectorAll('.avatar')];
    expect(first).toHaveTextContent('M');
    expect(first?.className).toContain(
      `avatar-tone-${toneOf('Marta Lindqvist')}`,
    );
    expect(second?.className).toContain(
      `avatar-tone-${toneOf('Marta Lindqvist')}`,
    );
    expect(second).toHaveClass('avatar-large');
    expect(empty).toHaveTextContent('?');
    for (const name of ['a', 'Bob', 'ç', 'team@example.com']) {
      expect(toneOf(name)).toBeGreaterThanOrEqual(0);
      expect(toneOf(name)).toBeLessThan(6);
    }
  });
});

describe('Tag and Notice', () => {
  it('say what they are about, an error at once', () => {
    render(
      <>
        <Tag tone="accent">Clients</Tag>
        <Notice tone="error">It did not work.</Notice>
        <Notice>Saved.</Notice>
      </>,
    );
    expect(screen.getByText('Clients')).toHaveClass('tag', 'tag-accent');
    expect(screen.getByRole('alert')).toHaveClass('notice', 'notice-error');
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
  });
});

describe('ThemeSwitch', () => {
  it('says what pressing it does, and does it', async () => {
    const theme = new Theme({
      storage: window.localStorage,
      root: document.documentElement,
    });
    render(<ThemeSwitch theme={theme} />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Switch to the dark theme' }),
    );
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    await userEvent.click(
      screen.getByRole('button', { name: 'Switch to the light theme' }),
    );
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });
});
