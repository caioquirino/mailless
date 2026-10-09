/*
 * The icons, as the path of each on a 24 by 24 grid. They are drawn as lines,
 * 1.9 wide with round ends, in the colour of the text around them.
 */
export const ICONS = {
  mail: 'M3 6h18v12H3zM3.5 6.5l8.5 7 8.5-7',
  calendar:
    'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM3 10h18M8 3v4M16 3v4',
  contacts: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 21c0-4 3.5-6 8-6s8 2 8 6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-3.5-3.5',
  write: 'M4 20h4L19 9l-4-4L4 16v4Z',
  archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
  junk: 'M8 3h8l5 5v8l-5 5H8l-5-5V8l5-5ZM12 8v5M12 16.5v.5',
  delete: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  unread: 'M3 8v10h18V8M3 8l9 6 9-6M3 8l9-5 9 5',
  snooze: 'M12 5a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM12 9v4l3 2M5 3 2 6M19 3l3 3',
  move: 'M3 6h6l2 2h10v11H3V6ZM10 13.5h5M13 11l2.5 2.5L13 16',
  label: 'M3 5h9l8 7-8 7H3V5ZM7.5 12h.01',
  more: 'M12 5h.01M12 12h.01M12 19h.01',
  reply: 'M9 7 4 12l5 5M4 12h10a6 6 0 0 1 6 6',
  'reply-all': 'M7 7 2 12l5 5M12 7l-5 5 5 5M7 12h9a6 6 0 0 1 6 6',
  forward: 'M15 7l5 5-5 5M20 12H10a6 6 0 0 0-6 6',
  flag: 'M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1L3.2 9.4l6.1-.8L12 3Z',
  refresh: 'M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5',
  // The gear of Feather Icons (MIT licence), which is drawn the same way as these.
  settings:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z',
  bell: 'M6 9a6 6 0 0 1 12 0c0 6 2.5 7 2.5 7h-17S6 15 6 9ZM10 20a2 2 0 0 0 4 0',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M6 6 4.6 4.6M19.4 19.4 18 18M18 6l1.4-1.4M4.6 19.4 6 18M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
  back: 'M19 12H5M11 6l-6 6 6 6',
  attach:
    'M20 11.5 12 19.5a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  'sign-out': 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h10',
  account:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM6.5 18.2c1-2 3-3.2 5.5-3.2s4.5 1.2 5.5 3.2',
  plus: 'M12 5v14M5 12h14',
  inbox: 'M3 13l3-8h12l3 8v6H3v-6ZM3 13h5l1 3h6l1-3h5',
  send: 'M4 12 20 4l-5 16-3-7-8-1Z',
  file: 'M6 3h8l4 4v14H6V3ZM14 3v4h4',
  folder: 'M3 6h6l2 2h10v11H3V6Z',
  'chevron-left': 'M15 5l-7 7 7 7',
  'chevron-right': 'M9 5l7 7-7 7',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-up': 'M6 15l6-6 6 6',
  // What a message being written can be given, and the window it is written in.
  bold: 'M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z',
  italic: 'M10 5h8M6 19h8M14 5l-4 14',
  underline: 'M7 4v7a5 5 0 0 0 10 0V4M5 20h14',
  heading: 'M6 5v14M18 5v14M6 12h12',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  numbered: 'M10 6h10M10 12h10M10 18h10M4 5h1v3M4 16h2l-2 3h2',
  quote: 'M5 5v14M9 8h10M9 12h10M9 16h6',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  plain: 'M6 5h12M12 5v14M9 19h6M4 4l16 16',
  format:
    'M4 19 9 6l5 13M5.6 15h6.8M16 12.5a2.5 2.5 0 0 1 5 0V19M21 16.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  emoji:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8M9 10h.01M15 10h.01',
  picture: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5h.01',
  phone:
    'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1Z',
  place:
    'M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11ZM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  birthday:
    'M4 20h16M5 20v-7h14v7M8 13v-3M12 13v-3M16 13v-3M8 7v.01M12 7v.01M16 7v.01',
  note: 'M5 4h14v16H5zM9 9h6M9 13h6M9 17h3',
  options:
    'M4 7h10M18 7h2M4 17h4M12 17h8M16 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM10 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  minimise: 'M6 18h12',
  expand: 'M5 9V5h4M19 9V5h-4M5 15v4h4M19 15v4h-4',
  shrink: 'M9 5v4H5M15 5v4h4M9 19v-4H5M15 19v-4h4',
} as const;

export type IconName = keyof typeof ICONS;
