# bat-sense

Use your phone as a motion controller for PC games (built for Cricket 07 on PCSX2).

- `mobile/`  - Expo / React Native app. Streams `DeviceMotion` (~60 Hz) over a WebSocket.
- `cricbat.py` - PC bridge. Trains per-game profiles and turns motion into key presses.

## PC
    pip install -r requirements.txt
    python cricbat.py train cricket07   # once per game; --only left,right to redo single actions
    python cricbat.py play  cricket07

The server prints the PC's LAN IP. Allow port 8765 through Windows Firewall (private networks).

## Phone
    cd mobile
    npm install
    npx expo start            # scan the QR with Expo Go (SDK 58), or:
    npx expo run:android      # dev build (needed for a standalone install)

Enter the PC's IP in the app, tap **Start**. During `train`, countdowns and instructions
are pushed to the phone screen (with vibration on GO) so you don't have to look at the monitor.

Cleartext `ws://` is enabled for LAN use (`usesCleartextTraffic` on Android,
`NSAllowsLocalNetworking` on iOS) in `mobile/app.json`.

## Protocol
phone -> PC: `{acceleration:{x,y,z}, accelerationIncludingGravity:{x,y,z}, rotation:{alpha,beta,gamma}}`
(rotation in **degrees**; expo-sensors reports radians, the app converts).
PC -> phone: `{type:"prompt", text, count, go}` during training.
