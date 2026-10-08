# @mailless/ui

The mailless design system: what every mailless page is made of, so that
they look and behave as one thing. The webmail and the admin interface are
built on it, and whatever comes next will be.

- **Tokens**: colours in light and dark, spacing, corner radii, shadows and
  type, defined once in [`tokens.json`](tokens.json).
- **Base styles**: how text is set, and the classes for buttons, notices,
  cards, tags and avatars.
- **A theme switch**: light or dark, following the system until someone
  chooses.
- **React components** that draw with those classes.

```css
/* Once, at the top of the application's own stylesheet. */
@import '@mailless/ui/styles.css';
```

```tsx
import { browserTheme, Button, IconButton, ThemeSwitch } from '@mailless/ui';

const theme = browserTheme(); // before anything is drawn

<Button variant="primary" icon="write">Write</Button>
<IconButton icon="archive" label="Archive" onClick={archive} />
<ThemeSwitch theme={theme} />
```

## Tokens

Every colour, space and radius a page uses is a CSS variable from here:
`var(--surface)`, `var(--space-4)`, `var(--radius)`. A page that holds no
colour of its own follows the theme without being told, and changes with the
system when a token changes.

| Token                                                     | For                                                |
| --------------------------------------------------------- | -------------------------------------------------- |
| `--page`                                                  | The ground everything sits on                      |
| `--surface`, `--raised`, `--hover`                        | Panes and cards; what is set off or pointed at     |
| `--text`, `--muted`                                       | What matters, and what is secondary                |
| `--border`, `--line`, `--border-strong`                   | Edges at rest, hairlines, edges of what is pressed |
| `--accent`, `--accent-text`                               | The one thing to do, links, what is chosen         |
| `--accent-soft`, `--accent-soft-text`                     | Behind what is selected                            |
| `--danger`, `--success`, `--warning` (+ `-soft`)          | What went wrong, what worked, what needs a look    |
| `--space-1` to `--space-6`                                | 4, 8, 12, 16, 24 and 32 pixels at the usual size   |
| `--radius-sm`, `--radius`, `--radius-lg`, `--radius-pill` | 6, 8 and 16 pixels, and fully round                |
| `--font-sans`, `--font-mono`                              | Hanken Grotesk, shipped with the package; code     |

`tokens.json` is the one place they are defined. After changing it:

```sh
node tools/build-tokens.mjs
```

writes `src/styles/tokens.css`, and the tests fail if that was forgotten.
The tests also check that every pairing of text and ground the usage notes
name can be read (a contrast of 4.5 to 1) in both themes, so a colour that
looks fine in one theme and cannot be read in the other does not get in.

## Themes

Light is the default; dark applies when the system asks for it. Someone who
chooses with `ThemeSwitch` is remembered in the browser, for every mailless
page on the site: the choice is written as `data-theme` on the page's root.
Choosing what the system already asks for goes back to following it.

## Components

| Component        | What it is                                                               |
| ---------------- | ------------------------------------------------------------------------ |
| `Button`         | A button with words: `primary`, `danger`, `quiet` or plain; with an icon |
| `IconButton`     | A button that is only an icon. It must be given a `label`                |
| `Icon`           | One of the icons, in the colour of the text around it                    |
| `Avatar`         | An initial on a colour that is always the same for the same name         |
| `Tag`            | A word or two about the thing beside it                                  |
| `Notice`         | Something the person should know; an error is announced at once          |
| `ThemeSwitch`    | Light or dark                                                            |
| `VisuallyHidden` | Words for those who cannot see what the page shows another way           |

Each can also be had without React, as its class: `button button-primary`,
`icon-button`, `tag tag-accent`, `notice notice-error`.

## Rules

- No colour, space or radius written by hand in an application: a token, or
  a new token here.
- One `primary` button on a screen.
- An icon alone always has a label; an icon beside words is decoration.
- Colours that must be told apart also differ in lightness, not hue alone.
