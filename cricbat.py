import asyncio
import websockets
import json
import pydirectinput
import time

# ─── PCSX2 Key Bindings for Cricket 07 ───────────────────────────────────────
# Verify these in PCSX2 > Config > Controllers (PAD) > Plugin Settings
KEY_CROSS     = 'z'       # Cross (X) — batting hit
KEY_LEFT      = 'left'    # D-pad left  — leg side
KEY_RIGHT     = 'right'   # D-pad right — off side
KEY_UP        = 'up'      # D-pad up    — straight drive
KEY_DOWN      = 'down'    # D-pad down  — back foot

# ─── Swing Detection Tuning ───────────────────────────────────────────────────
SWING_THRESHOLD   = 8.0    # Lower = more sensitive (was 12, try 8 first)
COOLDOWN_SECS     = 0.6    # Min seconds between swings
HIT_KEY_HOLD_MS   = 120    # Hold duration for hit key (ms)
DIR_KEY_HOLD_MS   = 150    # Hold duration for direction key (ms)

last_swing_time = 0.0
msg_count       = 0        # for diagnostics

async def press_key(key: str, hold_ms: int = 80):
    pydirectinput.keyDown(key)
    await asyncio.sleep(hold_ms / 1000)
    pydirectinput.keyUp(key)

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
        direction_key = KEY_LEFT
        dir_label = "LEG SIDE ◀"
    elif gamma > 20:
        direction_key = KEY_RIGHT
        dir_label = "OFF SIDE ▶"
    elif beta < -15:
        direction_key = KEY_UP
        dir_label = "STRAIGHT ▲"
    else:
        direction_key = None
        dir_label = "NEUTRAL"

    print(f"\n>>> SWING DETECTED  mag={magnitude:.1f}  gamma={gamma:.1f}  beta={beta:.1f}")
    print(f"    Shot: {dir_label}  →  pressing '{KEY_CROSS}'" +
          (f" + '{direction_key}'" if direction_key else ""))

    tasks = [press_key(KEY_CROSS, HIT_KEY_HOLD_MS)]
    if direction_key:
        tasks.append(press_key(direction_key, DIR_KEY_HOLD_MS))
    await asyncio.gather(*tasks)

async def handler(websocket):
    global msg_count
    print("\n[+] Mobile connected!\n")

    async for message in websocket:
        try:
            data = json.loads(message)
            msg_count += 1

            # ── BUG FIX: Android often returns null for 'acceleration'
            # Fall back to accelerationIncludingGravity (always available)
            acc = (data.get('acceleration')
                   or data.get('accelerationIncludingGravity')
                   or {})
            rot = data.get('rotation') or {}

            # Print first 5 messages so you can verify data is arriving
            if msg_count <= 5:
                print(f"[DEBUG msg #{msg_count}] acc={acc}  rot={rot}")
                if msg_count == 5:
                    ax = acc.get('x', 0) or 0
                    ay = acc.get('y', 0) or 0
                    az = acc.get('z', 0) or 0
                    mag = (ax**2 + ay**2 + az**2) ** 0.5
                    print(f"[DEBUG] Current magnitude={mag:.1f}  threshold={SWING_THRESHOLD}")
                    if mag < 1.0:
                        print("[WARN]  Magnitude near 0 — phone may not be sending acceleration data!")
                    else:
                        print("[OK]    Sensor data looks good. Swing the phone hard!")

            if not acc:
                continue

            await handle_swing(acc, rot)

        except json.JSONDecodeError:
            print("Bad JSON received")
        except Exception as e:
            print(f"Error: {e}")

async def main():
    print("=" * 55)
    print("  Cricket 07 — Mobile Bat Controller (PCSX2)")
    print("=" * 55)
    print(f"  Swing threshold : {SWING_THRESHOLD}  (lower = more sensitive)")
    print(f"  Hit key (Cross) : {KEY_CROSS}")
    print(f"  Direction keys  : {KEY_LEFT} / {KEY_RIGHT} / {KEY_UP}")
    print()
    print("  !! IMPORTANT — for keys to reach PCSX2:")
    print("     Click on the PCSX2 window to give it focus,")
    print("     THEN swing. Keys go to the focused window only.")
    print()
    print("  !! VERIFY in PCSX2 > Config > Controllers > PAD:")
    print(f"     Cross  = {KEY_CROSS}")
    print(f"     D-pad  = arrow keys")
    print("=" * 55)
    print("\nWaiting for mobile connection...\n")

    async with websockets.serve(handler, "0.0.0.0", 8765):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
