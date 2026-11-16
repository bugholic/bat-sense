"""
Phone-as-controller bridge (PCSX2 / any PC game).

    python cricbat.py list
    python cricbat.py train cricket07            # guided calibration, saves profiles/cricket07.json
    python cricbat.py train cricket07 --only left,right   # re-train some actions
    python cricbat.py train mygame               # no template -> interactive action wizard
    python cricbat.py play  cricket07            # live play with the trained profile

The phone page streams JSON over WebSocket (port 8765):
    {"acceleration": {x,y,z}, "rotation": {alpha,beta,gamma}}
"""
import argparse
import asyncio
import ctypes
import json
import math
import socket
import statistics
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import websockets
import win32con
import win32gui

PORT = 8765
PROFILE_DIR = Path(__file__).with_name("profiles")

# ─── Training / engine tuning ────────────────────────────────────────────────
REST_SECS        = 2.0     # hold still to capture neutral pose + noise floor
REPS             = 3       # repetitions per action
COUNTDOWN_SECS   = 3
CAPTURE_SECS     = 2.0     # window in which each rep is performed
SETTLE_SECS      = 1.0     # pause between reps
THRESHOLD_RATIO  = 0.5     # trigger at 50% of the trained peak
NOISE_MULT       = 3.0     # threshold must clear 3x resting noise
RELEASE_RATIO    = 0.6     # tilt hysteresis: release below 60% of trigger
SMOOTHING        = 0.6     # EMA weight of the newest orientation sample
DEFAULT_HOLD_MS  = 120     # tap length for swing actions
DEFAULT_COOLDOWN = 0.25    # min seconds between two swing triggers

# Starting points for known games. Thresholds/axes are learned by `train`.
TEMPLATES = {
    "cricket07": {
        "window_match": ["pcsx2", "cricket"],
        "actions": {
            "hit":   {"type": "swing", "key": "z"},
            "left":  {"type": "tilt",  "key": "left"},    # leg side
            "right": {"type": "tilt",  "key": "right"},   # off side
            "up":    {"type": "tilt",  "key": "up"},      # straight drive
            "down":  {"type": "tilt",  "key": "down"},    # back foot
        },
    },
}

# ─── SendInput plumbing ──────────────────────────────────────────────────────
INPUT_KEYBOARD  = 1
KEYEVENTF_KEYUP = 0x0002

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk",         ctypes.c_ushort),
                ("wScan",       ctypes.c_ushort),
                ("dwFlags",     ctypes.c_ulong),
                ("time",        ctypes.c_ulong),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

class INPUT(ctypes.Structure):
    class _INPUT(ctypes.Union):
        _fields_ = [("ki", KEYBDINPUT)]
    _anonymous_ = ("_input",)
    _fields_    = [("type", ctypes.c_ulong), ("_input", _INPUT)]

SPECIAL_VK = {
    "left": win32con.VK_LEFT, "right": win32con.VK_RIGHT,
    "up": win32con.VK_UP,     "down": win32con.VK_DOWN,
    "space": 0x20, "enter": 0x0D, "shift": 0x10, "ctrl": 0x11,
    "alt": 0x12,   "tab": 0x09,   "esc": 0x1B,
}

def vk_for(key: str):
    k = key.lower()
    if k in SPECIAL_VK:
        return SPECIAL_VK[k]
    if len(k) == 1:
        vk = ctypes.windll.user32.VkKeyScanW(ord(k)) & 0xFF
        return None if vk == 0xFF else vk
    if k.startswith("f") and k[1:].isdigit() and 1 <= int(k[1:]) <= 12:
        return 0x70 + int(k[1:]) - 1          # VK_F1..VK_F12
    return None

def _send(vk: int, flags: int):
    inp = INPUT()
    inp.type           = INPUT_KEYBOARD
    inp.ki.wVk         = vk
    inp.ki.wScan       = ctypes.windll.user32.MapVirtualKeyW(vk, 0)
    inp.ki.dwFlags     = flags
    inp.ki.time        = 0
    inp.ki.dwExtraInfo = ctypes.pointer(ctypes.c_ulong(0))
    ctypes.windll.user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))

def key_down(key: str):
    vk = vk_for(key)
    if vk is None:
        print(f"[WARN] Unknown key: {key}")
        return
    _send(vk, 0)

def key_up(key: str):
    vk = vk_for(key)
    if vk is not None:
        _send(vk, KEYEVENTF_KEYUP)

# ─── Sensor samples ──────────────────────────────────────────────────────────
@dataclass
class Sample:
    mag:   float    # |acceleration| (m/s^2)
    beta:  float    # front/back tilt (deg)
    gamma: float    # left/right tilt (deg)

def _vec(d):
    if not isinstance(d, dict):
        return None
    vals = [d.get(k) for k in "xyz"]
    if all(v is None for v in vals):
        return None
    return [v or 0.0 for v in vals]

def parse_sample(data: dict):
    v   = _vec(data.get("acceleration")) or _vec(data.get("accelerationIncludingGravity"))
    rot = data.get("rotation") or {}
    beta, gamma = rot.get("beta"), rot.get("gamma")
    if v is None and beta is None and gamma is None:
        return None
    mag = math.sqrt(sum(x * x for x in v)) if v else 0.0
    return Sample(mag, beta or 0.0, gamma or 0.0)

def angle_delta(a: float, b: float) -> float:
    """Signed shortest difference a-b in degrees, wrapped to [-180, 180)."""
    return (a - b + 180.0) % 360.0 - 180.0

# ─── Profiles ────────────────────────────────────────────────────────────────
def profile_path(game: str) -> Path:
    return PROFILE_DIR / f"{game}.json"

def load_profile(game: str):
    p = profile_path(game)
    return json.loads(p.read_text()) if p.exists() else None

def save_profile(game: str, profile: dict):
    PROFILE_DIR.mkdir(exist_ok=True)
    profile_path(game).write_text(json.dumps(profile, indent=2))

# ─── Real-time engine ────────────────────────────────────────────────────────
class Engine:
    """
    Stateless-per-sample trigger logic. `down`/`up`/`call_later` are injected so
    it can be driven by SendInput + asyncio in production and by a fake in tests.

    tilt  : key is HELD while the phone is tilted past the trained threshold
            along the trained axis/sign; released (with hysteresis) on return.
    swing : key is tapped on the rising edge of |mag - rest_mag| crossing the
            threshold; re-armed once motion falls below half the threshold.
    """
    def __init__(self, profile, down, up, call_later, clock=time.monotonic):
        self.rest    = profile["rest"]
        self.actions = profile["actions"]
        self.down, self.up, self.call_later, self.clock = down, up, call_later, clock
        self.held    = set()        # action names currently held (tilt)
        self.armed   = {n: True for n in self.actions}
        self.last    = {n: 0.0 for n in self.actions}
        self.ema     = {"beta": None, "gamma": None}

    def _smooth(self, axis: str, value: float) -> float:
        prev = self.ema[axis]
        cur = value if prev is None else prev + SMOOTHING * angle_delta(value, prev)
        self.ema[axis] = cur
        return cur

    def feed(self, s: Sample):
        angles = {"beta": self._smooth("beta", s.beta),
                  "gamma": self._smooth("gamma", s.gamma)}
        dev_mag = abs(s.mag - self.rest["mag"])
        now = self.clock()

        for name, a in self.actions.items():
            thr = a["threshold"]
            if a["type"] == "tilt":
                d = angle_delta(angles[a["axis"]], self.rest[a["axis"]]) * a["sign"]
                if name not in self.held and d >= thr:
                    self.held.add(name)
                    self.down(a["key"]);  print(f"  ▼ {name:<8} {a['key']}  ({d:+.0f}°)")
                elif name in self.held and d < thr * RELEASE_RATIO:
                    self.held.discard(name)
                    self.up(a["key"]);    print(f"  ▲ {name:<8} {a['key']}")
            else:  # swing
                if self.armed[name] and dev_mag >= thr and now - self.last[name] >= a.get("cooldown", DEFAULT_COOLDOWN):
                    self.armed[name] = False
                    self.last[name]  = now
                    self.down(a["key"])
                    self.call_later(a.get("hold_ms", DEFAULT_HOLD_MS) / 1000, self.up, a["key"])
                    held = ",".join(sorted(self.held)) or "-"
                    print(f"  ★ {name:<8} {a['key']}  (mag {dev_mag:.1f}, dir held: {held})")
                elif not self.armed[name] and dev_mag < thr * 0.5:
                    self.armed[name] = True

    def release_all(self):
        for name in list(self.held):
            self.up(self.actions[name]["key"])
        self.held.clear()

# ─── Trainer ─────────────────────────────────────────────────────────────────
class Trainer:
    """Collects live samples while a capture window is open, then derives the
    rest pose, noise floor and per-action axis / sign / threshold."""
    def __init__(self):
        self.buf = None
        self.seen = asyncio.Event()

    def feed(self, s: Sample):
        self.seen.set()
        if self.buf is not None:
            self.buf.append(s)

    async def capture(self, secs: float):
        self.buf = []
        await asyncio.sleep(secs)
        out, self.buf = self.buf, None
        return out

    async def countdown(self, label: str):
        announce(f"\n  → {label}")
        for i in range(COUNTDOWN_SECS, 0, -1):
            announce(f"     {i}...", count=i)
            await asyncio.sleep(1)
        announce("     GO!", go=True)

    async def measure_rest(self):
        await self.countdown("Hold the phone STILL in your batting stance")
        s = await self.capture(REST_SECS)
        if len(s) < 5:
            raise RuntimeError("Got <5 sensor samples while resting - is the phone streaming?")
        rest = {
            "beta":  statistics.median(x.beta for x in s),
            "gamma": statistics.median(x.gamma for x in s),
            "mag":   statistics.median(x.mag for x in s),
        }
        rest["noise_angle"] = max(max(abs(angle_delta(x.beta, rest["beta"])),
                                      abs(angle_delta(x.gamma, rest["gamma"]))) for x in s)
        rest["noise_mag"] = max(abs(x.mag - rest["mag"]) for x in s)
        print(f"     rest: beta={rest['beta']:.1f} gamma={rest['gamma']:.1f} mag={rest['mag']:.2f} "
              f"(noise ±{rest['noise_angle']:.1f}° / ±{rest['noise_mag']:.2f})")
        return rest

    @staticmethod
    def _peaks(samples, rest):
        """Signed extreme deviation per axis + peak |mag| deviation for one rep."""
        def extreme(vals):
            return max(vals, key=abs) if vals else 0.0
        return {
            "beta":  extreme([angle_delta(s.beta, rest["beta"]) for s in samples]),
            "gamma": extreme([angle_delta(s.gamma, rest["gamma"]) for s in samples]),
            "mag":   max((abs(s.mag - rest["mag"]) for s in samples), default=0.0),
        }

    async def train_action(self, name, spec, rest, key_hint):
        kind = spec["type"]
        while True:
            peaks = []
            for rep in range(1, REPS + 1):
                if kind == "swing":
                    msg = f"[{name}] rep {rep}/{REPS}: SWING the phone like the bat"
                else:
                    msg = f"[{name}] rep {rep}/{REPS}: TILT the phone toward '{name}' and hold it, then return"
                await self.countdown(msg)
                peaks.append(self._peaks(await self.capture(CAPTURE_SECS), rest))
                print("     done.")
                await asyncio.sleep(SETTLE_SECS)

            if kind == "swing":
                med = statistics.median(p["mag"] for p in peaks)
                thr = max(med * THRESHOLD_RATIO, rest["noise_mag"] * NOISE_MULT, 2.0)
                if med < rest["noise_mag"] * NOISE_MULT:
                    print(f"     ✗ swing peak {med:.1f} barely above noise - swing harder / retry")
                    continue
                result = {"type": "swing", "key": spec["key"], "threshold": round(thr, 2),
                          "hold_ms": spec.get("hold_ms", DEFAULT_HOLD_MS),
                          "cooldown": spec.get("cooldown", DEFAULT_COOLDOWN)}
                print(f"     ✓ swing peak ~{med:.1f} → trigger at {thr:.1f}")
                return result

            # tilt: majority axis, sign from the median signed peak on that axis
            axis = max(("beta", "gamma"),
                       key=lambda ax: statistics.median(abs(p[ax]) for p in peaks))
            med_signed = statistics.median(p[axis] for p in peaks)
            sign = 1 if med_signed >= 0 else -1
            mags = [abs(p[axis]) for p in peaks if (p[axis] >= 0) == (sign > 0)]
            med = statistics.median(mags) if mags else 0.0
            if len(mags) < max(2, REPS // 2 + 1) or med < max(5.0, rest["noise_angle"] * NOISE_MULT):
                print(f"     ✗ inconsistent / too small tilt ({med:.0f}°) - retry")
                continue
            thr = max(med * THRESHOLD_RATIO, rest["noise_angle"] * NOISE_MULT, 5.0)
            print(f"     ✓ axis={axis} sign={sign:+d} peak ~{med:.0f}° → trigger at {thr:.0f}°")
            return {"type": "tilt", "key": spec["key"], "axis": axis, "sign": sign,
                    "threshold": round(thr, 1)}

    async def run(self, game, profile, only):
        print("\nWaiting for the phone to start streaming...")
        await self.seen.wait()
        print("[+] Receiving sensor data.")

        profile["rest"] = await self.measure_rest()
        for name, spec in profile["actions"].items():
            if only and name not in only:
                continue
            profile["actions"][name] = await self.train_action(name, spec, profile["rest"], spec["key"])

        # Sanity: two tilt actions must not share axis+sign
        tilts = {n: (a["axis"], a["sign"]) for n, a in profile["actions"].items()
                 if a["type"] == "tilt" and "axis" in a}
        seen = {}
        for n, k in tilts.items():
            if k in seen:
                print(f"[WARN] '{n}' and '{seen[k]}' resolved to the same axis/sign {k} - re-train one of them.")
            seen[k] = n

        save_profile(game, profile)
        print(f"\n[OK] Saved {profile_path(game)}")
        print(f"     Play with:  python cricbat.py play {game}")

# ─── Window helper (informational) ───────────────────────────────────────────
def find_window(patterns):
    hits = []
    def cb(hwnd, _):
        if win32gui.IsWindowVisible(hwnd):
            t = win32gui.GetWindowText(hwnd).lower()
            if any(p in t for p in patterns):
                hits.append(win32gui.GetWindowText(hwnd))
    win32gui.EnumWindows(cb, None)
    return hits[0] if hits else None

def minimize_console():
    hwnd = ctypes.windll.kernel32.GetConsoleWindow()
    if hwnd:
        ctypes.windll.user32.ShowWindow(hwnd, win32con.SW_MINIMIZE)

# ─── WebSocket server ────────────────────────────────────────────────────────
def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))      # UDP connect: picks the LAN interface, sends nothing
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()

_clients = set()

def announce(text: str, count=None, go=False):
    """Print on the PC and push to the phone, so you can train without looking at the monitor."""
    print(text)
    msg = json.dumps({"type": "prompt", "text": text.strip(), "count": count, "go": go})
    for ws in list(_clients):
        asyncio.ensure_future(ws.send(msg))

async def serve(consumer, on_disconnect=lambda: None):
    msg_count = 0

    async def handler(ws):
        nonlocal msg_count
        print("\n[+] Mobile connected!")
        _clients.add(ws)
        try:
            async for message in ws:
                try:
                    s = parse_sample(json.loads(message))
                except json.JSONDecodeError:
                    continue
                if s is None:
                    continue
                msg_count += 1
                if msg_count == 5 and abs(s.mag) < 0.01 and s.beta == 0 and s.gamma == 0:
                    print("[WARN] Sensor values are all 0 - phone may not be sending motion data!")
                consumer(s)
        finally:
            _clients.discard(ws)
            on_disconnect()          # never leave a key stuck down
            print("[-] Mobile disconnected")

    print(f"\n  In the bat-sense app, enter this PC address:  {lan_ip()}   (port {PORT})")
    async with websockets.serve(handler, "0.0.0.0", PORT):
        await asyncio.Future()

# ─── Commands ────────────────────────────────────────────────────────────────
async def ask(prompt):
    return (await asyncio.get_running_loop().run_in_executor(None, input, prompt)).strip()

async def wizard():
    """Define actions for a game that has no template."""
    print("Define the game's actions. Blank name to finish.")
    actions = {}
    while True:
        name = await ask("  action name (e.g. jump, left): ")
        if not name:
            break
        kind = await ask("    type [tilt/swing] (tilt = hold while tilted, swing = tap on flick): ")
        key  = await ask("    keyboard key to press (e.g. z, left, space): ")
        if kind not in ("tilt", "swing") or vk_for(key) is None:
            print("    invalid type or key, skipped")
            continue
        actions[name] = {"type": kind, "key": key}
    pat = await ask("  window title contains (optional, e.g. pcsx2): ")
    return {"window_match": [pat.lower()] if pat else [], "actions": actions}

async def cmd_train(args):
    existing = load_profile(args.game)
    if existing:
        profile = existing
    elif args.game in TEMPLATES:
        profile = json.loads(json.dumps(TEMPLATES[args.game]))
    else:
        profile = await wizard()
    if not profile["actions"]:
        print("No actions defined."); return
    profile["game"] = args.game
    only = set(args.only.split(",")) if args.only else None
    if only and not only <= set(profile["actions"]):
        print(f"Unknown action(s): {only - set(profile['actions'])}"); return

    trainer = Trainer()
    print("=" * 55)
    print(f"  TRAINING: {args.game}   actions: {', '.join(profile['actions'])}")
    print(f"  Open the phone page and connect to ws://<this-pc-ip>:{PORT}")
    print("=" * 55)
    server = asyncio.create_task(serve(trainer.feed))
    run = asyncio.create_task(trainer.run(args.game, profile, only))
    done, _ = await asyncio.wait({server, run}, return_when=asyncio.FIRST_COMPLETED)
    for t in (server, run):
        t.cancel()
    for t in done:
        if t.exception():
            print(f"[ERROR] {t.exception()}")

async def cmd_play(args):
    profile = load_profile(args.game)
    if not profile:
        print(f"No profile '{args.game}'. Run:  python cricbat.py train {args.game}"); return
    loop = asyncio.get_running_loop()
    engine = Engine(profile, key_down, key_up, loop.call_later)

    print("=" * 55)
    print(f"  PLAY: {args.game}")
    for n, a in profile["actions"].items():
        extra = f"{a['axis']}{'+' if a['sign'] > 0 else '-'}" if a["type"] == "tilt" else "flick"
        print(f"    {n:<8} {a['type']:<5} key={a['key']:<6} {extra:<7} trigger={a['threshold']}")
    print("=" * 55)
    w = find_window(profile.get("window_match", []))
    print(f"[INFO] Game window: {w!r}" if w else "[WARN] Game window not found - open it, keys go to the focused window.")
    print("Waiting for mobile connection... (console will minimize)\n")
    if not args.no_minimize:
        minimize_console()
    try:
        await serve(engine.feed, engine.release_all)
    finally:
        engine.release_all()

def cmd_list():
    names = sorted(p.stem for p in PROFILE_DIR.glob("*.json")) if PROFILE_DIR.exists() else []
    print("Trained profiles:", ", ".join(names) or "(none)")
    print("Templates       :", ", ".join(TEMPLATES))

def main():
    for stream in (sys.stdout, sys.stderr):      # arrows/stars must not crash on cp1252 consoles
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Phone motion → keyboard bridge")
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train", help="calibrate a game profile")
    t.add_argument("game"); t.add_argument("--only", help="comma list of actions to re-train")
    p = sub.add_parser("play", help="run a trained profile")
    p.add_argument("game"); p.add_argument("--no-minimize", action="store_true")
    sub.add_parser("list", help="list profiles")
    args = ap.parse_args()
    if args.cmd == "list":
        return cmd_list()
    try:
        asyncio.run(cmd_train(args) if args.cmd == "train" else cmd_play(args))
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
