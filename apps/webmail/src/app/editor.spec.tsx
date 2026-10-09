import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Editor } from './editor';

function editor(html: string, tools = true) {
  const written: string[] = [];
  render(
    <Editor
      html={html}
      label="Message"
      tools={tools}
      focused
      onChange={(next) => written.push(next)}
    />,
  );
  return { box: screen.getByLabelText('Message'), written };
}

/** An address that would run something, which no link may be. */
const SCRIPT = ['java', 'script:alert(1)'].join('');

describe('the editor', () => {
  it('starts from what was written before, keeping only what a message is made of', () => {
    const { box } = editor(
      '<p>Hello <b>Bob</b></p><script>alert(1)</script><ul><li>one</li></ul>loose words',
    );
    expect(box.querySelector('strong')).toHaveTextContent('Bob');
    expect(box.querySelector('li')).toHaveTextContent('one');
    expect(box.querySelector('script')).toBeNull();
    expect(box).not.toHaveTextContent('alert');
    // Words outside any paragraph are given one.
    expect(box.querySelector('p:last-child')).toHaveTextContent('loose words');
  });

  it('says what is written, as it is written', async () => {
    const { box, written } = editor('');
    await userEvent.type(box, 'Thursday?');
    expect(written.at(-1)).toContain('Thursday?');
  });

  it('makes words bold, and a line a list or a quote', async () => {
    const { box, written } = editor('');
    const bold = screen.getByRole('button', { name: 'Bold' });
    expect(bold).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(bold);
    await userEvent.type(box, 'Now');
    expect(written.at(-1)).toMatch(/<(b|strong)[ >].*Now/);
    expect(bold).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(
      screen.getByRole('button', { name: 'Bulleted list' }),
    );
    expect(written.at(-1)).toMatch(/<ul><li[^>]*>.*Now/);
    await userEvent.click(
      screen.getByRole('button', { name: 'Bulleted list' }),
    );
    expect(written.at(-1)).not.toContain('<ul>');

    await userEvent.click(screen.getByRole('button', { name: 'Quote' }));
    expect(written.at(-1)).toMatch(/<blockquote[^>]*>.*Now/);
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove formatting' }),
    );
    expect(written.at(-1)).not.toMatch(/<blockquote|<b>|<strong/);
  });

  it('asks where a link leads, and takes nothing that is not an address', async () => {
    editor('<p>the page</p>');
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    const address = screen.getByLabelText('Where the link leads');
    await userEvent.type(address, `${SCRIPT}{Enter}`);
    expect(address).toHaveAttribute('aria-invalid', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
  });

  it('offers to follow, change or remove the link the cursor is in', async () => {
    const long = `https://example.com/${'a'.repeat(60)}/end`;
    const { box, written } = editor(
      `<p>See <a href="${long}">the page</a> and more</p>`,
    );
    expect(
      screen.queryByRole('group', { name: 'Link' }),
    ).not.toBeInTheDocument();

    await userEvent.click(within(box).getByText('the page'));
    const bar = await screen.findByRole('group', { name: 'Link' });
    const go = within(bar).getByRole('link');
    expect(go).toHaveAttribute('href', long);
    expect(go).toHaveAttribute('target', '_blank');
    // Too long to show whole: its two ends, with the middle left out.
    expect(go.textContent).toMatch(/^https:\/\/example\.com\/a+…a+\/end$/);
    expect(go.textContent?.length).toBeLessThan(50);

    await userEvent.click(within(bar).getByRole('button', { name: 'Change' }));
    const address = within(bar).getByLabelText('Where the link leads');
    expect(address).toHaveValue(long);
    await userEvent.clear(address);
    await userEvent.type(address, 'example.org/b{Enter}');
    expect(written.at(-1)).toContain('href="https://example.org/b"');
    expect(within(bar).getByRole('link')).toHaveTextContent(
      'https://example.org/b',
    );

    await userEvent.click(within(bar).getByRole('button', { name: 'Remove' }));
    expect(written.at(-1)).not.toContain('<a ');
    expect(written.at(-1)).toContain('the page');
    expect(
      screen.queryByRole('group', { name: 'Link' }),
    ).not.toBeInTheDocument();
  });

  it('hides its buttons when asked', () => {
    editor('', false);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });
});
