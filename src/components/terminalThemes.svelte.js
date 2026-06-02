/**
 * Terminal color themes for the embedded xterm terminal, selectable via the `terminalTheme` setting.
 * One module owns the palettes, the derived setting `choices` map, and the reactive active-theme store.
 */

/**
 * @typedef {object} TerminalThemeEntry
 * @property {string} label - Human-readable name shown in the settings dropdown.
 * @property {object} theme - An xterm `ITheme` (background, foreground, cursor, and the 16 ANSI colors).
 */

/**
 * The available terminal themes, keyed by id.
 * @type {Record<string, TerminalThemeEntry>}
 */
export const TERMINAL_THEMES = {
   'tokyo-night': {
      label: 'Tokyo Night',
      theme: {
         background: '#1a1b26', foreground: '#c0caf5', cursor: '#7aa2f7', cursorAccent: '#1a1b26',
         selectionBackground: '#28304d',
         black: '#414868', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
         blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
         brightBlack: '#565f89', brightRed: '#ff7a93', brightGreen: '#b9f27c', brightYellow: '#ff9e64',
         brightBlue: '#7da6ff', brightMagenta: '#bb9af7', brightCyan: '#0db9d7', brightWhite: '#c0caf5',
      },
   },
   'tokyo-night-deep': {
      label: 'Tokyo Night Deep',
      theme: {
         background: '#12131c', foreground: '#d7ddf2', cursor: '#4a9eff', cursorAccent: '#12131c',
         selectionBackground: '#28304d',
         black: '#414868', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
         blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c0caf5',
         brightBlack: '#565f89', brightRed: '#ff7a93', brightGreen: '#b9f27c', brightYellow: '#ff9e64',
         brightBlue: '#7da6ff', brightMagenta: '#bb9af7', brightCyan: '#0db9d7', brightWhite: '#ffffff',
      },
   },
   'wiretap-contrast': {
      label: 'Wiretap Contrast',
      theme: {
         background: '#0e0f14', foreground: '#e8eaf0', cursor: '#4a9eff', cursorAccent: '#0e0f14',
         selectionBackground: '#243049',
         black: '#2a2c33', red: '#ff6b6b', green: '#5af78e', yellow: '#f3f99d',
         blue: '#6cb6ff', magenta: '#c792ea', cyan: '#5ad4e6', white: '#d6dae0',
         brightBlack: '#5c6370', brightRed: '#ff8a8a', brightGreen: '#7ee787', brightYellow: '#ffe98a',
         brightBlue: '#8ac8ff', brightMagenta: '#ffb3e1', brightCyan: '#8ae6f2', brightWhite: '#ffffff',
      },
   },
   'one-dark': {
      label: 'One Dark',
      theme: {
         background: '#282c34', foreground: '#abb2bf', cursor: '#61afef', cursorAccent: '#282c34',
         selectionBackground: '#3e4451',
         black: '#3f4451', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
         blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
         brightBlack: '#4f5666', brightRed: '#ff7a85', brightGreen: '#a9d77f', brightYellow: '#f0ca8a',
         brightBlue: '#74c0ff', brightMagenta: '#d68ce6', brightCyan: '#63c6d2', brightWhite: '#ffffff',
      },
   },
   dracula: {
      label: 'Dracula',
      theme: {
         background: '#282a36', foreground: '#f8f8f2', cursor: '#bd93f9', cursorAccent: '#282a36',
         selectionBackground: '#44475a',
         black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
         blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
         brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
         brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
      },
   },
};

/**
 * Setting `choices` map (id -> label) derived from TERMINAL_THEMES, for the dropdown.
 * @type {Record<string, string>}
 */
export const TERMINAL_THEME_CHOICES = Object.fromEntries(
   Object.entries(TERMINAL_THEMES).map(([id, entry]) => [id, entry.label]),
);

/**
 * Reactive holder for the active theme id. The setting's onChange mutates `terminalTheme.id`, which the
 * terminal component observes to re-theme live.
 * @type {{ id: string }}
 */
export const terminalTheme = $state({ id: 'tokyo-night' });
