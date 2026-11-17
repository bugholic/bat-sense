import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, Vibration, View } from 'react-native';

// On-screen controller (joystick + user-defined buttons). Motion keeps streaming in parallel;
// the pad only sends {type:"key", key, down} edges, which cricbat.py turns into SendInput.

export const MAX_BUTTONS = 8;
export const STICK_PRESETS = {
  off: null,
  arrows: { up: 'up', down: 'down', left: 'left', right: 'right' },
  wasd: { up: 'w', down: 's', left: 'a', right: 'd' },
};
export const DEFAULT_PAD = {
  stick: 'arrows',
  buttons: [{ id: 'b1', label: 'A', key: 'x' }, { id: 'b2', label: 'B', key: 'c' }],
};

// Mirrors vk_for() / SPECIAL_VK in cricbat.py.
const SPECIAL = ['left', 'right', 'up', 'down', 'space', 'enter', 'shift', 'ctrl', 'alt', 'tab', 'esc',
  'backspace', 'delete', 'insert', 'home', 'end', 'pgup', 'pgdn'];
export const validKey = (raw) => {
  const k = String(raw ?? '').trim().toLowerCase();
  return /^[a-z0-9`\-=[\]\\;',./]$/.test(k) || SPECIAL.includes(k) || /^f([1-9]|1[0-2])$/.test(k);
};

export function normalizePad(raw) {
  if (!raw || typeof raw !== 'object') return DEFAULT_PAD;
  const stick = raw.stick in STICK_PRESETS ? raw.stick : DEFAULT_PAD.stick;
  const buttons = (Array.isArray(raw.buttons) ? raw.buttons : [])
    .filter((b) => b && validKey(b.key))
    .slice(0, MAX_BUTTONS)
    .map((b, i) => ({ id: String(b.id || `b${i}`), label: String(b.label || b.key).slice(0, 8), key: b.key.trim().toLowerCase() }));
  return { stick, buttons };
}

const DEAD = 0.3;     // stick dead zone (fraction of radius)
const DIAG = 0.383;   // sin(22.5°): splits the circle into 8 equal 45° sectors
function stickKeys(x, y, map) {
  const m = Math.hypot(x, y);
  if (!map || m < DEAD) return [];
  const nx = x / m, ny = y / m, out = [];
  if (nx > DIAG) out.push(map.right); else if (nx < -DIAG) out.push(map.left);
  if (ny > DIAG) out.push(map.down); else if (ny < -DIAG) out.push(map.up);
  return out;
}

const STICK = 170, KNOB = 60, KNOB_TRAVEL = (STICK - KNOB) / 2;
const inside = (r, x, y) => r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/**
 * Multi-touch pad. RN's responder system (Pressable / PanResponder) grants only one responder at a
 * time, so stick + button together would not work. Instead the container listens to raw
 * onTouch* events (which carry every pointer) and hit-tests pageX/pageY against window rects.
 */
export function Pad({ layout, send, colors: c }) {
  const map = STICK_PRESETS[layout.stick];
  const ctrlRefs = useRef({});            // control id -> View
  const rects = useRef({});               // control id -> window rect
  const owners = useRef(new Map());       // touch identifier -> control id
  const held = useRef(new Map());         // key -> refcount (stick + a button may share a key)
  const stickHeld = useRef([]);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [pressed, setPressed] = useState(() => new Set());

  const hold = useCallback((key) => {
    const n = held.current.get(key) || 0;
    held.current.set(key, n + 1);
    if (n === 0) send(key, true);
  }, [send]);
  const drop = useCallback((key) => {
    const n = held.current.get(key) || 0;
    if (n <= 1) { held.current.delete(key); if (n === 1) send(key, false); }
    else held.current.set(key, n - 1);
  }, [send]);

  const measure = useCallback(() => {
    requestAnimationFrame(() => {
      for (const [id, v] of Object.entries(ctrlRefs.current)) {
        v?.measureInWindow((x, y, w, h) => { rects.current[id] = { x, y, w, h }; });
      }
    });
  }, []);
  useEffect(measure, [layout, measure]);

  const setStick = useCallback((x, y) => {
    const next = stickKeys(x, y, map);
    const prev = stickHeld.current;
    prev.filter((k) => !next.includes(k)).forEach(drop);
    next.filter((k) => !prev.includes(k)).forEach(hold);
    stickHeld.current = next;
    setKnob({ x, y });
  }, [map, hold, drop]);

  const moveStick = useCallback((t) => {
    const r = rects.current.stick;
    if (!r) return;
    const rad = r.w / 2;
    let x = (t.pageX - (r.x + rad)) / rad, y = (t.pageY - (r.y + r.h / 2)) / rad;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    setStick(x, y);
  }, [setStick]);

  const release = useCallback((tid) => {
    const id = owners.current.get(tid);
    if (id == null) return;
    owners.current.delete(tid);
    if (id === 'stick') { setStick(0, 0); return; }
    const b = layout.buttons.find((x) => x.id === id);
    if (b) drop(b.key);
    setPressed((p) => { const n = new Set(p); n.delete(id); return n; });
  }, [layout, setStick, drop]);

  const releaseAll = useCallback(() => {
    [...owners.current.keys()].forEach(release);
  }, [release]);

  const onStart = (e) => {
    for (const t of e.nativeEvent.changedTouches) {
      if (owners.current.has(t.identifier)) continue;
      if (map && inside(rects.current.stick, t.pageX, t.pageY)) {
        if ([...owners.current.values()].includes('stick')) continue;  // one finger drives the stick
        owners.current.set(t.identifier, 'stick');
        moveStick(t);
        continue;
      }
      const b = layout.buttons.find((x) => inside(rects.current[x.id], t.pageX, t.pageY));
      if (!b) continue;
      owners.current.set(t.identifier, b.id);
      hold(b.key);
      setPressed((p) => new Set(p).add(b.id));
      if (Platform.OS === 'android') Vibration.vibrate(12);   // iOS ignores the duration (~400 ms)
    }
  };
  const onMove = (e) => {
    for (const t of e.nativeEvent.changedTouches) {
      if (owners.current.get(t.identifier) === 'stick') moveStick(t);
    }
  };
  const onEnd = (e) => {
    for (const t of e.nativeEvent.changedTouches) release(t.identifier);
    if (!e.nativeEvent.touches?.length) releaseAll();   // last finger up: never leave anything held
  };

  // Release on unmount / layout change so nothing is left pressed on the PC.
  useEffect(() => releaseAll, [releaseAll]);

  const reg = (id) => (v) => { if (v) ctrlRefs.current[id] = v; else delete ctrlRefs.current[id]; };

  return (
    <View
      style={s.pad}
      onLayout={measure}
      onTouchStart={onStart}
      onTouchMove={onMove}
      onTouchEnd={onEnd}
      onTouchCancel={onEnd}
    >
      <View style={s.stickCol}>
        {map ? (
          <View ref={reg('stick')} style={[s.stick, { borderColor: c.line, backgroundColor: c.panel }]} onLayout={measure}>
            <View style={[s.knob, { backgroundColor: c.accent, transform: [{ translateX: knob.x * KNOB_TRAVEL }, { translateY: knob.y * KNOB_TRAVEL }] }]} />
          </View>
        ) : <Text style={{ color: c.dim }}>Joystick off</Text>}
      </View>
      <View style={s.btnGrid}>
        {layout.buttons.map((b) => {
          const on = pressed.has(b.id);
          return (
            <View key={b.id} ref={reg(b.id)}
              style={[s.padBtn, { borderColor: on ? c.accent : c.line, backgroundColor: on ? c.accent : c.panel }]}>
              <Text style={[s.padBtnText, { color: on ? '#04121c' : c.text }]} numberOfLines={1}>{b.label}</Text>
              <Text style={[s.padBtnKey, { color: on ? '#04121c' : c.dim }]}>{b.key}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export const KEY_HELP = `Keys: a–z, 0–9, punctuation, f1–f12, ${SPECIAL.join(', ')}.`;

/** Controlled joystick + buttons fields; GameEditor owns the draft and the Save button. */
export function PadFields({ value, onChange, colors: c }) {
  const { stick, buttons } = value;
  const setButtons = (fn) => onChange({ ...value, buttons: fn(buttons) });
  const patch = (i, field, v) => setButtons((bs) => bs.map((b, j) => (j === i ? { ...b, [field]: v } : b)));
  const add = () => setButtons((bs) => [...bs, { id: `b${Date.now()}`, label: '', key: '' }]);
  const remove = (i) => setButtons((bs) => bs.filter((_, j) => j !== i));

  return (
    <>
      <Text style={[s.h, { color: c.text }]}>Joystick</Text>
      <View style={s.seg}>
        {Object.keys(STICK_PRESETS).map((k) => (
          <Pressable key={k} onPress={() => onChange({ ...value, stick: k })}
            style={[s.segItem, { borderColor: stick === k ? c.accent : c.line, backgroundColor: stick === k ? c.accent : c.panel }]}>
            <Text style={{ color: stick === k ? '#04121c' : c.text, fontWeight: '600' }}>
              {{ off: 'Off', arrows: 'Arrows', wasd: 'WASD' }[k]}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={[s.h, { color: c.text }]}>Buttons ({buttons.length}/{MAX_BUTTONS})</Text>
      {buttons.map((b, i) => {
        const bad = !validKey(b.key);
        return (
          <View key={b.id} style={s.row}>
            <TextInput style={[s.in, { flex: 1.2, color: c.text, borderColor: c.line }]} value={b.label}
              onChangeText={(v) => patch(i, 'label', v)} placeholder="Label" placeholderTextColor={c.dim} maxLength={8} />
            <TextInput style={[s.in, { flex: 1, color: c.text, borderColor: bad ? c.bad : c.line }]} value={b.key}
              onChangeText={(v) => patch(i, 'key', v)} placeholder="key" placeholderTextColor={c.dim}
              autoCapitalize="none" autoCorrect={false} />
            <Pressable onPress={() => remove(i)} style={[s.x, { borderColor: c.line }]} accessibilityLabel="Remove button">
              <Text style={{ color: c.bad, fontSize: 18 }}>×</Text>
            </Pressable>
          </View>
        );
      })}
      {buttons.length < MAX_BUTTONS && (
        <Pressable onPress={add} style={[s.add, { borderColor: c.line }]}>
          <Text style={{ color: c.accent, fontWeight: '600' }}>+ Add button</Text>
        </Pressable>
      )}
    </>
  );
}

export const padValid = (pad) => pad.buttons.every((b) => validKey(b.key));
export const finalizePad = (pad) =>
  normalizePad({ ...pad, buttons: pad.buttons.map((b) => ({ ...b, label: b.label.trim() || b.key.trim() })) });

// Shared editor styles (GameEditor reuses them).
export const editorStyles = () => s;

const s = StyleSheet.create({
  pad: { flex: 1, minHeight: 200, flexDirection: 'row', alignItems: 'center', gap: 12 },
  stickCol: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  stick: { width: STICK, height: STICK, borderRadius: STICK / 2, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  knob: { width: KNOB, height: KNOB, borderRadius: KNOB / 2, opacity: 0.9 },
  btnGrid: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center', alignContent: 'center' },
  padBtn: { width: 72, height: 72, borderRadius: 36, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  padBtnText: { fontSize: 17, fontWeight: '700' },
  padBtnKey: { fontSize: 11 },
  h: { fontSize: 16, fontWeight: '700' },
  seg: { flexDirection: 'row', gap: 8 },
  segItem: { flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  in: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 10, fontSize: 16, backgroundColor: '#0d141b' },
  x: { width: 42, height: 42, borderWidth: 1, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  add: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  done: { borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  pill: { width: 70, borderWidth: 1, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
});
