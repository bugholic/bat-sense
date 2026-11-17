import { useEffect, useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Network from 'expo-network';

export const PORT = 8765;                // must match PORT in cricbat.py
const DISCOVERY_PATH = '/batsense';      // must match DISCOVERY_PATH in cricbat.py
const BATCH = 48;                        // concurrent probes
const PROBE_MS = 900;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const hostOf = (target) => target.replace(/:\d+$/, '');

export async function phoneIp() {
  try {
    const ip = await Network.getIpAddressAsync();
    return IPV4.test(ip) && ip !== '0.0.0.0' ? ip : null;
  } catch { return null; }
}

/**
 * Accepts what the PC shows: the QR payload (batsense://ip:port), a full IP (optionally :port,
 * ws://...), or just the last number of the IP ("20" -> same /24 as the phone).
 * Returns "ip:port" or null.
 */
export function parseTarget(text, ownIp) {
  const t = String(text ?? '').trim().replace(/^(batsense|wss?|https?):\/\//i, '').replace(/\/.*$/, '');
  const m = t.match(/^([\d.]+)(?::(\d{1,5}))?$/);
  if (!m) return null;
  let ip = m[1];
  if (/^\d{1,3}$/.test(ip) && ownIp) ip = `${ownIp.split('.').slice(0, 3).join('.')}.${ip}`;
  const parts = ip.match(IPV4);
  if (!parts || parts.slice(1).some((p) => +p > 255)) return null;
  return `${ip}:${m[2] ?? PORT}`;
}

async function probe(target, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`http://${target}${DISCOVERY_PATH}`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.app === 'bat-sense' ? { target, name: String(j.name ?? '') } : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

/**
 * Finds cricbat.py on the LAN: tries the last known PC first, then probes every host of the
 * phone's /24 over HTTP (the PC answers GET /batsense on the WebSocket port).
 * Returns {target:"ip:port", name} or null. `cancelled()` aborts between batches.
 */
export async function discover(lastTarget, cancelled = () => false, onProgress = () => {}) {
  if (lastTarget) {
    const hit = await probe(lastTarget, 1200);
    if (hit) return hit;
  }
  const ip = await phoneIp();
  if (!ip) return null;
  const prefix = ip.split('.').slice(0, 3).join('.');
  const self = +ip.split('.')[3];
  const skip = lastTarget ? hostOf(lastTarget) : null;
  const hosts = [];
  for (let i = 1; i <= 254; i++) {
    const h = `${prefix}.${i}`;
    if (i !== self && h !== skip) hosts.push(`${h}:${PORT}`);
  }
  for (let i = 0; i < hosts.length; i += BATCH) {
    if (cancelled()) return null;
    onProgress(Math.min(1, i / hosts.length));
    const hits = (await Promise.all(hosts.slice(i, i + BATCH).map((h) => probe(h, PROBE_MS)))).filter(Boolean);
    if (hits.length) return hits[0];
  }
  return null;
}

export function QrScanner({ onResult, onClose, colors: c }) {
  const [perm, requestPerm] = useCameraPermissions();
  const done = useRef(false);

  useEffect(() => {
    if (perm && !perm.granted && perm.canAskAgain) requestPerm();
  }, [perm, requestPerm]);

  const onScan = async ({ data }) => {
    if (done.current) return;
    const target = parseTarget(data, await phoneIp());
    if (!target || done.current) return;
    done.current = true;
    onResult(target);
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={[s.root, { backgroundColor: c.bg }]}>
        {perm?.granted ? (
          <CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScan} />
        ) : (
          <Text style={[s.msg, { color: c.text }]}>
            {perm && !perm.canAskAgain ? 'Camera access is off. Enable it in system settings to scan.' : 'Waiting for camera permission…'}
          </Text>
        )}
        <View style={[s.frame, { borderColor: c.accent }]} pointerEvents="none" />
        <Text style={[s.caption, { color: '#fff' }]}>Point at the QR code in the cricbat.py window</Text>
        <Pressable onPress={onClose} style={[s.cancel, { backgroundColor: c.panel, borderColor: c.line }]}>
          <Text style={{ color: c.text, fontSize: 17, fontWeight: '700' }}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  msg: { fontSize: 16, padding: 24, textAlign: 'center' },
  frame: { position: 'absolute', width: 240, height: 240, borderWidth: 3, borderRadius: 16 },
  caption: { position: 'absolute', top: '22%', fontSize: 16, fontWeight: '600', textShadowColor: '#000', textShadowRadius: 4 },
  cancel: { position: 'absolute', bottom: 48, left: 24, right: 24, borderWidth: 1, borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
});
