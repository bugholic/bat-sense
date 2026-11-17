import { DEFAULT_PAD, normalizePad, validKey } from './Pad';

// Per-game setup, edited in the app and sent to cricbat.py on connect:
//   {type:"setup", game, actions:[{name, type:"swing"|"tilt", key}]}
// The PC trains thresholds per action; the app owns which actions exist and their keys.

export const GAMES_KEY = 'batsense.games';
export const LEGACY_PAD_KEY = 'batsense.pad';
export const MAX_ACTIONS = 10;

// Game and action names become file names / CLI args on the PC (NAME_RE in cricbat.py).
export const validName = (n) => /^[a-z0-9_-]{1,24}$/.test(n);
export const cleanName = (n) => String(n ?? '').trim().toLowerCase().replace(/\s+/g, '-');

const CRICKET07 = {
  actions: [
    { name: 'hit', type: 'swing', key: 'z' },
    { name: 'left', type: 'tilt', key: 'left' },
    { name: 'right', type: 'tilt', key: 'right' },
    { name: 'up', type: 'tilt', key: 'up' },
    { name: 'down', type: 'tilt', key: 'down' },
  ],
  pad: DEFAULT_PAD,
};

export const defaultStore = () => ({ current: 'cricket07', games: { cricket07: CRICKET07 } });

export function normalizeGame(raw) {
  const seen = new Set();
  const actions = (Array.isArray(raw?.actions) ? raw.actions : [])
    .map((a) => ({ name: cleanName(a?.name), type: a?.type === 'tilt' ? 'tilt' : 'swing', key: String(a?.key ?? '').trim().toLowerCase() }))
    .filter((a) => validName(a.name) && validKey(a.key) && !seen.has(a.name) && seen.add(a.name))
    .slice(0, MAX_ACTIONS);
  return { actions, pad: normalizePad(raw?.pad) };
}

export function normalizeStore(raw, legacyPad) {
  const base = defaultStore();
  if (legacyPad) base.games.cricket07 = { ...CRICKET07, pad: normalizePad(legacyPad) };
  if (!raw || typeof raw !== 'object' || !raw.games) return base;
  const games = {};
  for (const [name, g] of Object.entries(raw.games)) {
    if (validName(name)) games[name] = normalizeGame(g);
  }
  if (!Object.keys(games).length) return base;
  const current = games[raw.current] ? raw.current : Object.keys(games)[0];
  return { current, games };
}

export const setupMessage = (store) => ({
  type: 'setup',
  game: store.current,
  actions: store.games[store.current]?.actions ?? [],
});
