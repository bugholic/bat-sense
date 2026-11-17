# bat-sense

Use your phone as a motion controller for PC games (built for Cricket 07 on PCSX2).

- `mobile/`  - Expo / React Native app. Holds your games, streams `DeviceMotion` (~60 Hz) and
  on-screen joystick/buttons over a WebSocket.
- `cricbat.py` - PC bridge. Trains per-game motion profiles and turns input into key presses.

## Quick start
    pip install -r requirements.txt
    python cricbat.py train     # once per game (trains the game selected in the app)
    python cricbat.py play

On the phone: pick or create a game, tap **Start**. The app finds the PC on the same Wi-Fi by
itself. If it can't (hotspots, guest networks, non-/24 subnets), tap **Scan QR** and scan the QR
code `cricbat.py` prints, or **Enter IP** (the full IP, or just its last number).

Allow port 8765 through Windows Firewall (private networks). Discovery uses the same port.

## Games (defined in the app)
Tap **+ New game** or **Setup** to edit a game:
- **Motion actions**: name + `swing` (tap the key on a flick: shots, smash) or `tilt` (hold the key
  while tilted: aim, lean) + key. `train` learns each action's axis/threshold.
- **Joystick**: Off / Arrows / WASD (8-way) and up to 8 **buttons** (label + key), for movement and
  extra actions. They show after Start, work multi-touch alongside motion, and need no training.

Keys: `a-z`, `0-9`, punctuation, `f1-f12`, `left right up down space enter shift ctrl alt tab esc
backspace delete insert home end pgup pgdn`.

Changing a key in the app applies on the next `play` without retraining. Adding an action, or
changing its type, needs `python cricbat.py train --only <name>`. `train`/`play` also accept a
game name to override the app's selection.

## Phone
    cd mobile
    npm install
    npx expo start            # scan the QR with Expo Go (SDK 58), or:
    npx expo run:android      # dev build (needed for a standalone install)

During `train`, countdowns and instructions are pushed to the phone screen (with vibration on GO)
so you don't have to look at the monitor.

Cleartext `ws://` / `http://` is enabled for LAN use (`usesCleartextTraffic` on Android,
`NSAllowsLocalNetworking` on iOS) in `mobile/app.json`.

## Protocol
- discovery: phone `GET http://<ip>:8765/batsense` across its /24 -> `{"app":"bat-sense","name":<hostname>}`
- phone -> PC on connect: `{type:"setup", game, actions:[{name, type:"swing"|"tilt", key}]}`
  (game/action names `^[a-z0-9_-]{1,24}$`; they become `profiles/<game>.json`)
- phone -> PC: `{acceleration:{x,y,z}, accelerationIncludingGravity:{x,y,z}, rotation:{alpha,beta,gamma}}`
  (rotation in **degrees**; expo-sensors reports radians, the app converts)
- phone -> PC: `{type:"key", key, down}` on-screen pad edges (used by `play`, ignored by `train`).
  Keys are refcounted per source, so a pad hold and a tilt hold on the same key don't release each other.
- PC -> phone: `{type:"prompt", text, count, go}` during training
