import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, Vibration, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { DeviceMotion } from 'expo-sensors';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Pad } from './Pad';
import { GameEditor } from './GameEditor';
import { GAMES_KEY, LEGACY_PAD_KEY, normalizeStore, setupMessage } from './games';
import { QrScanner, discover, parseTarget, phoneIp } from './connect';

const SEND_INTERVAL_MS = 16; // ~60 Hz
const HOST_KEY = 'batsense.host'; // last PC that worked, "ip:port"
const RAD2DEG = 180 / Math.PI;

const c = {
  bg: '#0b0f14', panel: '#131a22', line: '#223040', text: '#e6edf3', dim: '#7d8b99',
  ok: '#3ddc84', warn: '#ffb020', bad: '#ff5c5c', accent: '#4cc2ff',
};

function Bar({ label, value, range, centered, unit }) {
  const f = Math.max(-1, Math.min(1, value / range));
  const fill = centered
    ? { left: `${f < 0 ? 50 + f * 50 : 50}%`, width: `${Math.abs(f) * 50}%` }
    : { left: 0, width: `${Math.max(0, f) * 100}%` };
  return (
    <View style={s.barRow}>
      <Text style={s.barLabel}>{label}</Text>
      <View style={s.barTrack}>
        {centered && <View style={s.barMid} />}
        <View style={[s.barFill, fill]} />
      </View>
      <Text style={s.barValue}>{value.toFixed(unit === '°' ? 0 : 1)}{unit}</Text>
    </View>
  );
}

function Main() {
  const insets = useSafeAreaInsets();
  const [host, setHost] = useState('');          // "ip:port" of the PC
  const [pcName, setPcName] = useState('');
  const [manual, setManual] = useState(false);   // show the manual address field
  const [manualText, setManualText] = useState('');
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState('idle'); // idle | searching | connecting | streaming | reconnecting
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState(null);   // {text, count, go} pushed by the PC trainer
  const [live, setLive] = useState({ beta: 0, gamma: 0, mag: 0, hz: 0 });
  const [store, setStore] = useState(() => normalizeStore(null));
  const [editing, setEditing] = useState(null); // null | {name: string|null}  (null name = new game)

  const wsRef = useRef(null);
  const subRef = useRef(null);
  const wantRef = useRef(false);        // user intent: should we be connected?
  const retryRef = useRef({ n: 0, timer: null });
  const promptTimer = useRef(null);
  const latest = useRef({ beta: 0, gamma: 0, mag: 0 });
  const sent = useRef(0);
  const setupRef = useRef(setupMessage(store));
  setupRef.current = setupMessage(store);

  useEffect(() => {
    AsyncStorage.getItem(HOST_KEY).then((v) => v && setHost(v)).catch(() => {});
    AsyncStorage.multiGet([GAMES_KEY, LEGACY_PAD_KEY]).then(([[, games], [, pad]]) => {
      const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
      setStore(normalizeStore(parse(games), parse(pad)));
    }).catch(() => {});
  }, []);

  const saveStore = useCallback((next) => {
    setStore(next);
    AsyncStorage.setItem(GAMES_KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  const rememberHost = useCallback((target, name = '') => {
    setHost(target); setPcName(name);
    AsyncStorage.setItem(HOST_KEY, target).catch(() => {});
  }, []);

  // Pad key edges are never dropped (unlike motion frames, which are skipped under backpressure).
  const sendKey = useCallback((key, down) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'key', key, down }));
  }, []);

  // UI refresh decoupled from the 60 Hz sensor stream so rendering never delays sends.
  useEffect(() => {
    if (status === 'idle' || status === 'searching') return;
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const hz = Math.round((sent.current * 1000) / (now - last));
      sent.current = 0; last = now;
      setLive({ ...latest.current, hz });
    }, 150);
    return () => clearInterval(id);
  }, [status]);

  const showPrompt = useCallback((p) => {
    clearTimeout(promptTimer.current);
    // The instruction line arrives once, then count/GO messages follow: keep the instruction on screen.
    const isTick = p.count || p.go;
    setPrompt((prev) => ({ ...p, label: isTick ? prev?.label ?? '' : p.text.replace(/^→\s*/, '') }));
    if (p.go) Vibration.vibrate(200);
    else if (p.count) Vibration.vibrate(30);
    promptTimer.current = setTimeout(() => setPrompt(null), p.go ? 2500 : 6000);
  }, []);

  const openSocket = useCallback((target) => {
    setStatus(retryRef.current.n ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(`ws://${target}`);
    wsRef.current = ws;
    ws.onopen = () => {
      // Tell the PC which game + actions to train/play; sent before any motion frame.
      ws.send(JSON.stringify(setupRef.current));
      retryRef.current.n = 0; setError(''); setStatus('streaming');
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'prompt') showPrompt(m);
      } catch { /* ignore non-JSON */ }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (wsRef.current !== ws) return;           // superseded / intentionally closed
      if (!wantRef.current) return;
      const n = ++retryRef.current.n;
      setStatus('reconnecting');
      if (n === 3) setError(`Lost the PC at ${target}. Is cricbat.py still running? Same Wi-Fi?`);
      retryRef.current.timer = setTimeout(() => openSocket(target), Math.min(3000, 400 * n));
    };
  }, [showPrompt]);

  const stop = useCallback(() => {
    wantRef.current = false;
    clearTimeout(retryRef.current.timer);
    retryRef.current.n = 0;
    subRef.current?.remove(); subRef.current = null;
    const ws = wsRef.current; wsRef.current = null;
    ws?.close();
    deactivateKeepAwake('batsense').catch(() => {});
    setPrompt(null); setStatus('idle');
  }, []);

  /** Connects to `forced` if given, else finds the PC (last known → subnet scan). */
  const start = useCallback(async (forced) => {
    setError('');
    if (!setupRef.current.actions.length && !store.games[store.current]?.pad.buttons.length) {
      setError(`"${store.current}" has nothing to send. Tap Setup to add actions or buttons.`); return;
    }
    if (!(await DeviceMotion.isAvailableAsync())) { setError('Motion sensors are not available on this device.'); return; }
    // No DeviceMotion.requestPermissionsAsync() here: it asks for ACTIVITY_RECOGNITION (Android 10+)
    // / CMPedometer "Motion & Fitness" (iOS), pedometer permissions that reading accelerometer,
    // gyro and rotation does not need. Expo Go often reports them denied with no toggle to fix it,
    // so we just subscribe and let the watchdog below report if no samples arrive.

    wantRef.current = true;
    let target = typeof forced === 'string' ? forced : null;
    if (!target) {
      setStatus('searching');
      const found = await discover(host, () => !wantRef.current);
      if (!wantRef.current) return;                 // Stop pressed while searching
      if (found) {
        target = found.target;
        rememberHost(found.target, found.name);
      } else if (host) {
        target = host;                              // not answering probes (old cricbat.py?) - try anyway
      } else {
        wantRef.current = false; setStatus('idle');
        setError('No PC found on this Wi-Fi. Is cricbat.py running and port 8765 allowed in the firewall? '
          + 'Or tap Scan QR.');
        return;
      }
    }

    activateKeepAwakeAsync('batsense').catch(() => {});
    DeviceMotion.setUpdateInterval(SEND_INTERVAL_MS);
    subRef.current?.remove();
    let gotMotion = false;
    setTimeout(() => {
      if (wantRef.current && !gotMotion) {
        setError('No motion data from the sensors. Close and reopen the app; if it persists, '
          + 'check that sensor access is not blocked (Android: Settings → Privacy → Sensors off; '
          + 'iOS: Settings → Privacy → Motion & Fitness → Fitness Tracking).');
      }
    }, 2500);
    subRef.current = DeviceMotion.addListener((m) => {
      // expo-sensors `rotation` is in RADIANS (verified in native source); the PC side works in degrees.
      const r = m.rotation;
      if (!r) return;
      gotMotion = true;
      const beta = r.beta * RAD2DEG, gamma = r.gamma * RAD2DEG;
      const a = m.acceleration;
      latest.current = { beta, gamma, mag: a ? Math.hypot(a.x, a.y, a.z) : 0 };

      const ws = wsRef.current;
      if (ws && ws.readyState === 1 && ws.bufferedAmount < 4096) {
        ws.send(JSON.stringify({
          acceleration: a && { x: a.x, y: a.y, z: a.z },
          accelerationIncludingGravity: m.accelerationIncludingGravity && {
            x: m.accelerationIncludingGravity.x, y: m.accelerationIncludingGravity.y, z: m.accelerationIncludingGravity.z,
          },
          rotation: { alpha: r.alpha * RAD2DEG, beta, gamma },
        }));
        sent.current++;
      }
    });
    openSocket(target);
  }, [host, store, openSocket, rememberHost]);

  useEffect(() => stop, [stop]); // cleanup on unmount

  const connectManual = useCallback(async () => {
    const target = parseTarget(manualText, await phoneIp());
    if (!target) { setError('Enter the IP shown by cricbat.py, e.g. 192.168.1.20 (or just 20).'); return; }
    rememberHost(target); setManual(false);
    start(target);
  }, [manualText, rememberHost, start]);

  const onScanned = useCallback((target) => {
    setScanning(false);
    rememberHost(target);
    start(target);
  }, [rememberHost, start]);

  const saveGame = useCallback((oldName, name, game) => {
    const games = { ...store.games };
    if (oldName && oldName !== name) delete games[oldName];
    games[name] = game;
    saveStore({ current: name, games });
    setEditing(null);
  }, [store, saveStore]);

  const deleteGame = useCallback((name) => {
    Alert.alert(`Delete "${name}"?`, 'Its actions and buttons are removed from the app. Trained data on the PC stays.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => {
        const games = { ...store.games };
        delete games[name];
        saveStore({ current: Object.keys(games)[0], games });
        setEditing(null);
      } },
    ]);
  }, [store, saveStore]);

  const running = status !== 'idle';
  const game = store.games[store.current];
  const dot = status === 'streaming' ? c.ok : running ? c.warn : c.bad;
  const label = {
    idle: 'Not connected', searching: 'Looking for your PC…', connecting: 'Connecting…',
    streaming: 'Streaming', reconnecting: 'Reconnecting…',
  }[status];

  if (editing) {
    const names = Object.keys(store.games);
    return (
      <View style={[s.root, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
        <Text style={s.title}>{editing.name ? `Edit ${editing.name}` : 'New game'}</Text>
        <GameEditor
          key={editing.name ?? '+new'}
          name={editing.name}
          game={editing.name ? store.games[editing.name] : null}
          otherNames={names.filter((n) => n !== editing.name)}
          onSave={(name, g) => saveGame(editing.name, name, g)}
          onDelete={names.length > 1 ? deleteGame : null}
          onCancel={() => setEditing(null)}
          colors={c}
        />
        <StatusBar style="light" />
      </View>
    );
  }

  return (
    <View style={[s.root, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
      <Text style={s.title}>bat<Text style={{ color: c.accent }}>-sense</Text></Text>

      {!running && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={s.chips}>
          {Object.keys(store.games).map((n) => (
            <Pressable key={n} onPress={() => saveStore({ ...store, current: n })}
              style={[s.chip, n === store.current && s.chipOn]}>
              <Text style={[s.chipText, n === store.current && { color: '#04121c' }]}>{n}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => setEditing({ name: null })} style={[s.chip, { borderStyle: 'dashed' }]}>
            <Text style={[s.chipText, { color: c.accent }]}>+ New game</Text>
          </Pressable>
        </ScrollView>
      )}

      <View style={s.card}>
        <View style={s.statusRow}>
          <View style={[s.dot, { backgroundColor: dot }]} />
          <Text style={s.statusText}>{label}</Text>
          {status === 'streaming' && <Text style={s.hz}>{live.hz} Hz</Text>}
        </View>
        <Text style={s.label}>
          {running ? `${store.current} · ` : ''}
          {host ? `PC ${pcName ? `${pcName} (${host.replace(/:8765$/, '')})` : host.replace(/:8765$/, '')}` : 'PC: found automatically on Start'}
        </Text>
        {!running && (
          <View style={s.linkRow}>
            <Pressable onPress={() => setScanning(true)} hitSlop={8}><Text style={s.link}>Scan QR</Text></Pressable>
            <Pressable onPress={() => setManual((v) => !v)} hitSlop={8}><Text style={s.link}>Enter IP</Text></Pressable>
          </View>
        )}
        {manual && !running && (
          <TextInput
            style={s.input}
            value={manualText}
            onChangeText={setManualText}
            placeholder="192.168.1.20 or just 20"
            placeholderTextColor={c.dim}
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            returnKeyType="go"
            onSubmitEditing={connectManual}
          />
        )}
        {!!error && <Text style={s.error}>{error}</Text>}
      </View>

      <View style={s.btnRow}>
        <Pressable
          onPress={running ? stop : manual && manualText.trim() ? connectManual : () => start()}
          style={({ pressed }) => [s.btn, { flex: 1 }, running && s.btnStop, pressed && { opacity: 0.8 }]}
          accessibilityRole="button"
        >
          <Text style={[s.btnText, running && { color: c.text }]}>{running ? 'Stop' : 'Start'}</Text>
        </Pressable>
        {!running && (
          <Pressable onPress={() => setEditing({ name: store.current })} accessibilityRole="button"
            style={({ pressed }) => [s.btn, s.btnStop, s.btnSide, pressed && { opacity: 0.8 }]}>
            <Text style={[s.btnText, { color: c.text }]}>Setup</Text>
          </Pressable>
        )}
      </View>

      {prompt ? (
        <View style={[s.card, s.liveCard, s.promptCard]}>
          {prompt.go ? <Text style={s.promptBig}>GO!</Text>
            : prompt.count ? <Text style={s.promptBig}>{prompt.count}</Text> : null}
          {!!prompt.label && <Text style={s.promptText}>{prompt.label}</Text>}
        </View>
      ) : (
        <View style={[s.card, s.liveCard]}>
          <Bar label="beta" value={live.beta} range={90} centered unit="°" />
          <Bar label="gamma" value={live.gamma} range={90} centered unit="°" />
          <Bar label="motion" value={live.mag} range={30} unit="" />
        </View>
      )}

      {status === 'streaming' || status === 'reconnecting' ? <Pad layout={game.pad} send={sendKey} colors={c} /> : (
        <Text style={s.hint}>
          {game.actions.length
            ? `${store.current}: ${game.actions.map((a) => `${a.name} (${a.type} → ${a.key})`).join(', ')}`
            : `${store.current} has no motion actions yet. Tap Setup.`}
          {'\n\n'}On the PC run  python cricbat.py train  once for this game, then  python cricbat.py play.
          Tap Start here and the app finds the PC by itself.
        </Text>
      )}
      {scanning && <QrScanner onResult={onScanned} onClose={() => setScanning(false)} colors={c} />}
      <StatusBar style="light" />
    </View>
  );
}

export default function App() {
  return <SafeAreaProvider><Main /></SafeAreaProvider>;
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg, paddingHorizontal: 16, gap: 14 },
  title: { color: c.text, fontSize: 22, fontWeight: '700', letterSpacing: 0.5 },
  chips: { gap: 8 },
  chip: { borderWidth: 1, borderColor: c.line, backgroundColor: c.panel, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  chipText: { color: c.text, fontWeight: '600' },
  card: { backgroundColor: c.panel, borderColor: c.line, borderWidth: 1, borderRadius: 12, padding: 14 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  statusText: { color: c.text, fontSize: 16, flex: 1 },
  hz: { color: c.dim, fontVariant: ['tabular-nums'] },
  label: { color: c.dim, fontSize: 13 },
  linkRow: { flexDirection: 'row', gap: 20, marginTop: 10 },
  link: { color: c.accent, fontSize: 14, fontWeight: '600' },
  input: { color: c.text, backgroundColor: '#0d141b', borderColor: c.line, borderWidth: 1, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 12, fontSize: 18, marginTop: 10 },
  error: { color: c.bad, marginTop: 10, fontSize: 14 },
  btn: { backgroundColor: c.accent, borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  btnStop: { backgroundColor: c.panel, borderColor: c.line, borderWidth: 1 },
  btnRow: { flexDirection: 'row', gap: 10 },
  btnSide: { paddingHorizontal: 18 },
  btnText: { color: '#04121c', fontSize: 17, fontWeight: '700' },
  liveCard: { height: 150, justifyContent: 'center' },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 7 },
  barLabel: { color: c.dim, width: 52, fontSize: 13 },
  barTrack: { flex: 1, height: 10, backgroundColor: '#0d141b', borderRadius: 5, overflow: 'hidden' },
  barMid: { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, backgroundColor: c.line },
  barFill: { position: 'absolute', top: 0, bottom: 0, backgroundColor: c.accent, borderRadius: 5 },
  barValue: { color: c.text, width: 56, textAlign: 'right', fontVariant: ['tabular-nums'], fontSize: 14 },
  promptCard: { alignItems: 'center', borderColor: c.accent },
  promptBig: { color: c.accent, fontSize: 72, fontWeight: '800' },
  promptText: { color: c.text, fontSize: 20, textAlign: 'center', fontWeight: '600' },
  hint: { color: c.dim, fontSize: 13, lineHeight: 19 },
});
