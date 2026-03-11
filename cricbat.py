import asyncio
import websockets
import json
import time
import ctypes
import win32gui
import win32con

# ─── PCSX2 Key Bindings for Cricket 07 ───────────────────────────────────────
KEY_CROSS     = 'z'       # Cross (X) — batting hit
KEY_LEFT      = 'left'    # D-pad left  — leg side
KEY_RIGHT     = 'right'   # D-pad right — off side
KEY_UP        = 'up'      # D-pad up    — straight drive
KEY_DOWN      = 'down'    # D-pad down  — back foot

# ─── Swing Detection Tuning ───────────────────────────────────────────────────
SWING_THRESHOLD   = 8.0
COOLDOWN_SECS     = 0.6
HIT_KEY_HOLD_MS   = 120
DIR_KEY_HOLD_MS   = 150

VK_MAP = {
    'z':     0x5A,
    'left':  win32con.VK_LEFT,
    'right': win32con.VK_RIGHT,
    'up':    win32con.VK_UP,
    'down':  win32con.VK_DOWN,
}

last_swing_time = 0.0
msg_count       = 0
_pcsx2_hwnd     = None

# ─── ctypes structs for SendInput ────────────────────────────────────────────
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

def _make_input(vk_code, flags):
    inp = INPUT()
    inp.type          = INPUT_KEYBOARD
    inp.ki.wVk        = vk_code
    inp.ki.wScan      = ctypes.windll.user32.MapVirtualKeyW(vk_code, 0)
    inp.ki.dwFlags    = flags
    inp.ki.time       = 0
    inp.ki.dwExtraInfo = ctypes.pointer(ctypes.c_ulong(0))
    return inp

# ─── Window helpers ───────────────────────────────────────────────────────────
def minimize_console():
    """Minimize this script's own console window."""
    hwnd = ctypes.windll.kernel32.GetConsoleWindow()
    if hwnd:
        ctypes.windll.user32.ShowWindow(hwnd, win32con.SW_MINIMIZE)

def get_pcsx2_hwnd():
    global _pcsx2_hwnd
    if _pcsx2_hwnd and win32gui.IsWindow(_pcsx2_hwnd):
        return _pcsx2_hwnd
    result = []
    def cb(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return
        title = win32gui.GetWindowText(hwnd).lower()
        if 'pcsx2' in title or 'cricket' in title:
            result.append(hwnd)
    win32gui.EnumWindows(cb, None)
    _pcsx2_hwnd = result[0] if result else None
    if _pcsx2_hwnd:
        print(f"[INFO] Found PCSX2 window: '{win32gui.GetWindowText(_pcsx2_hwnd)}'")
    else:
        print("[WARN] PCSX2 window not found — open it before swinging!")
    return _pcsx2_hwnd

def focus_pcsx2():
    """Bring PCSX2 to foreground so SendInput reaches it."""
    hwnd = get_pcsx2_hwnd()
    if hwnd:
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.SetForegroundWindow(hwnd)
        time.sleep(0.05)

# ─── Key sending ─────────────────────────────────────────────────────────────
def _send_key(vk, hold_ms):
    down = _make_input(vk, 0)
    up   = _make_input(vk, KEYEVENTF_KEYUP)
    ctypes.windll.user32.SendInput(1, ctypes.byref(down), ctypes.sizeof(INPUT))
    time.sleep(hold_ms / 1000)
    ctypes.windll.user32.SendInput(1, ctypes.byref(up),   ctypes.sizeof(INPUT))

async def press_key(key: str, hold_ms: int = 80):
    vk = VK_MAP.get(key)
    if not vk:
        print(f"[WARN] Unknown key: {key}")
        return
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _send_key, vk, hold_ms)

# ─── Swing logic ─────────────────────────────────────────────────────────────
async def handle_swing(acc: dict, rot: dict):
    global last_swing_time

    ax = acc.get('x', 0) or 0
    ay = acc.get('y', 0) or 0
    az = acc.get('z', 0) or 0
    magnitude = (ax**2 + ay**2 + az**2) ** 0.5

    if magnitude < SWING_THRESHOLD:
        return

    now = time.time()
    if now - last_swing_time < COOLDOWN_SECS:
        return
    last_swing_time = now

    gamma = rot.get('gamma', 0) or 0
    beta  = rot.get('beta',  0) or 0

    if gamma < -20:
        direction_key = KEY_LEFT;  dir_label = "LEG SIDE ◀"
    elif gamma > 20:
        direction_key = KEY_RIGHT; dir_label = "OFF SIDE ▶"
    elif beta < -15:
        direction_key = KEY_UP;    dir_label = "STRAIGHT ▲"
    else:
        direction_key = None;      dir_label = "NEUTRAL"

    print(f"\n>>> SWING  mag={magnitude:.1f}  gamma={gamma:.1f}  beta={beta:.1f}  → {dir_label}")

    await press_key(KEY_CROSS, HIT_KEY_HOLD_MS)
    if direction_key:
        await press_key(direction_key, DIR_KEY_HOLD_MS)

# ─── WebSocket handler ────────────────────────────────────────────────────────
async def handler(websocket):
    global msg_count
    print("\n[+] Mobile connected!\n")

    async for message in websocket:
        try:
            data = json.loads(message)
            msg_count += 1

            acc = (data.get('acceleration')
                   or data.get('accelerationIncludingGravity')
                   or {})
            rot = data.get('rotation') or {}

            if msg_count <= 5:
                print(f"[DEBUG #{msg_count}] acc={acc}  rot={rot}")
                if msg_count == 5:
                    ax = acc.get('x', 0) or 0
                    ay = acc.get('y', 0) or 0
                    az = acc.get('z', 0) or 0
                    mag = (ax**2 + ay**2 + az**2) ** 0.5
                    print(f"[DEBUG] magnitude={mag:.1f}  threshold={SWING_THRESHOLD}")
                    if mag < 1.0:
                        print("[WARN]  Magnitude near 0 — phone may not be sending sensor data!")
                    else:
                        print("[OK]    Sensor data good. Swing hard!")

            if not acc:
                continue

            await handle_swing(acc, rot)

        except json.JSONDecodeError:
            print("Bad JSON")
        except Exception as e:
            print(f"Error: {e}")

# ─── Entry point ──────────────────────────────────────────────────────────────
async def main():
    print("=" * 55)
    print("  Cricket 07 — Mobile Bat Controller (PCSX2)")
    print("=" * 55)
    print(f"  Swing threshold : {SWING_THRESHOLD}")
    print(f"  Hit key (Cross) : {KEY_CROSS}  |  D-pad: arrow keys")
    print()
    print("  VERIFY in PCSX2 > Config > Controllers > PAD:")
    print(f"     Cross = {KEY_CROSS},  Left/Right/Up = arrow keys")
    print("=" * 55)
    print("\nWaiting for mobile connection...")
    print("Console will minimize — PCSX2 must stay open.\n")

    # Find PCSX2 window now
    get_pcsx2_hwnd()

    # Minimize our console so PCSX2 keeps focus
    minimize_console()

    async with websockets.serve(handler, "0.0.0.0", 8765):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
