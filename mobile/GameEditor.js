import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { DEFAULT_PAD, KEY_HELP, PadFields, editorStyles, finalizePad, padValid, validKey } from './Pad';
import { MAX_ACTIONS, cleanName, validName } from './games';

const s = editorStyles();

/**
 * Edits one game: name, motion actions (trained on the PC) and on-screen pad.
 * `name` null = creating a new game.
 */
export function GameEditor({ name, game, otherNames, onSave, onDelete, onCancel, colors: c }) {
  const [draftName, setDraftName] = useState(name ?? '');
  const [actions, setActions] = useState(game?.actions ?? [{ name: 'shot', type: 'swing', key: '' }]);
  const [pad, setPad] = useState(game?.pad ?? DEFAULT_PAD);

  const patch = (i, field, v) => setActions((as) => as.map((a, j) => (j === i ? { ...a, [field]: v } : a)));
  const add = () => setActions((as) => [...as, { name: '', type: 'swing', key: '' }]);
  const remove = (i) => setActions((as) => as.filter((_, j) => j !== i));

  const gname = cleanName(draftName);
  const names = actions.map((a) => cleanName(a.name));
  const problem =
    !validName(gname) ? 'Game name: lowercase letters, digits, - or _'
    : otherNames.includes(gname) ? `A game named "${gname}" already exists`
    : names.some((n) => !validName(n)) ? 'Every action needs a name (letters, digits, - or _)'
    : new Set(names).size !== names.length ? 'Action names must be unique'
    : actions.some((a) => !validKey(a.key)) ? 'Fix the keys outlined in red'
    : !padValid(pad) ? 'Fix the button keys outlined in red'
    : null;

  const save = () => {
    if (problem) return;
    onSave(gname, {
      actions: actions.map((a, i) => ({ name: names[i], type: a.type, key: a.key.trim().toLowerCase() })),
      pad: finalizePad(pad),
    });
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 14, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
      <Text style={[s.h, { color: c.text }]}>Game</Text>
      <TextInput style={[s.in, { color: c.text, borderColor: validName(gname) ? c.line : c.bad }]} value={draftName}
        onChangeText={setDraftName} placeholder="e.g. badminton" placeholderTextColor={c.dim}
        autoCapitalize="none" autoCorrect={false} maxLength={24} />

      <Text style={[s.h, { color: c.text }]}>Motion actions ({actions.length}/{MAX_ACTIONS})</Text>
      <Text style={{ color: c.dim, fontSize: 13, lineHeight: 19 }}>
        Swing = taps the key on a flick (shots, smash). Tilt = holds the key while the phone is tilted
        (aim, lean). The PC learns each one when you run: python cricbat.py train
      </Text>
      {actions.map((a, i) => (
        <View key={i} style={s.row}>
          <TextInput style={[s.in, { flex: 1.3, color: c.text, borderColor: validName(cleanName(a.name)) ? c.line : c.bad }]}
            value={a.name} onChangeText={(v) => patch(i, 'name', v)} placeholder="name" placeholderTextColor={c.dim}
            autoCapitalize="none" autoCorrect={false} maxLength={24} />
          <Pressable onPress={() => patch(i, 'type', a.type === 'swing' ? 'tilt' : 'swing')}
            style={[s.pill, { borderColor: c.accent, backgroundColor: a.type === 'swing' ? c.accent : c.panel }]}
            accessibilityLabel={`Type ${a.type}, tap to change`}>
            <Text style={{ color: a.type === 'swing' ? '#04121c' : c.accent, fontWeight: '700' }}>{a.type}</Text>
          </Pressable>
          <TextInput style={[s.in, { flex: 1, color: c.text, borderColor: validKey(a.key) ? c.line : c.bad }]}
            value={a.key} onChangeText={(v) => patch(i, 'key', v)} placeholder="key" placeholderTextColor={c.dim}
            autoCapitalize="none" autoCorrect={false} />
          <Pressable onPress={() => remove(i)} style={[s.x, { borderColor: c.line }]} accessibilityLabel="Remove action">
            <Text style={{ color: c.bad, fontSize: 18 }}>×</Text>
          </Pressable>
        </View>
      ))}
      {actions.length < MAX_ACTIONS && (
        <Pressable onPress={add} style={[s.add, { borderColor: c.line }]}>
          <Text style={{ color: c.accent, fontWeight: '600' }}>+ Add action</Text>
        </Pressable>
      )}

      <PadFields value={pad} onChange={setPad} colors={c} />
      <Text style={{ color: c.dim, fontSize: 13, lineHeight: 19 }}>{KEY_HELP}</Text>

      {!!problem && <Text style={{ color: c.bad, fontSize: 14 }}>{problem}</Text>}
      <Pressable onPress={save} disabled={!!problem} style={[s.done, { backgroundColor: problem ? c.line : c.accent }]}>
        <Text style={{ color: '#04121c', fontSize: 17, fontWeight: '700' }}>Save</Text>
      </Pressable>
      <View style={s.row}>
        <Pressable onPress={onCancel} style={[s.add, { flex: 1, borderColor: c.line, borderStyle: 'solid' }]}>
          <Text style={{ color: c.text, fontWeight: '600' }}>Cancel</Text>
        </Pressable>
        {name != null && onDelete && (
          <Pressable onPress={() => onDelete(name)} style={[s.add, { flex: 1, borderColor: c.bad, borderStyle: 'solid' }]}>
            <Text style={{ color: c.bad, fontWeight: '600' }}>Delete game</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}
