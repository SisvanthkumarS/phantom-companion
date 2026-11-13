# Shadow — Browser Companion

Dark. Loyal. Always watching.

## Setup

```bash
npm install
npm run build
```

Then in Chrome:
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `dist/` folder

## Usage

- Say **"Arise"** → Shadow appears
- Talk to it — voice only
- Say **"Shadow leave"** → disappears
- Hotkey fallback: **Alt + A**

## Structure

```
src/
  content/
    index.js      ← main companion logic
    character.js  ← 3D Spline character + movement
    wakeword.js   ← "Arise" detection (Web Speech API)
    voice.js      ← STT listen + TTS speak
    context.js    ← passive page reading
    uswm.js       ← USWM client (stubbed Phase 1, live Phase 2)
  background/
    index.js      ← service worker
public/
  manifest.json
  popup.html/js   ← extension popup
  shadow.css      ← injected styles
```

## Phase Roadmap

| Phase | What | Days |
|-------|------|------|
| 1 (now) | Extension + character + voice + stub USWM | 1-4 |
| 2 | USWM backend on EC2, live integration | 5-6 |
| 3 | Character reacts to z_t, demo polish | 7-10 |

## Spline Character

After building your shadow soldier character in Spline:
1. Publish the scene
2. Copy the `.splinecode` URL
3. Replace the `TODO` in `character.js` `_loadSpline()`:
   ```js
   app.load('https://prod.spline.design/YOUR_SCENE_ID/scene.splinecode');
   ```

The fallback SVG character renders until Spline is wired up.
