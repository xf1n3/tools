# MCBE UI Studio v5 — Standalone

## No npm / no build

This version is a single `index.html`. It has no npm dependencies, no Vite, no `npm install`, and no `npm start`.

You can open `index.html` directly in Safari/Chrome, or host the folder with GitHub Pages/static hosting.

## Use

1. Open `index.html`.
2. Press **ZIP** and select the entire Minecraft Bedrock resource pack ZIP.
3. The app reads the ZIP locally in the browser.
4. Open `ui/hud_screen.json` (it is selected automatically when present).
5. Edit JSON and see the HUD update live.
6. On iPhone, tap a HUD element and drag it with your finger. The Inspector lets you edit X/Y/Width/Height/Layer and anchors.
7. Press **Export ZIP** to create an edited resource pack.

The resource pack never needs to be uploaded to GitHub. It is processed in browser memory.

## Recommended resource-pack ZIP structure

The ZIP should contain the resource-pack files at its root, not another ZIP nested inside it:

```text
my_resource_pack.zip
├── manifest.json
├── pack_icon.png
├── ui/
│   ├── hud_screen.json
│   ├── hud_screen.jsonc
│   └── ...
├── textures/
│   ├── ui/
│   │   ├── hit.png
│   │   ├── hit1.png
│   │   ├── hit2.png
│   │   ├── hit3.png
│   │   ├── hitmarker.png
│   │   └── ...
│   └── ...
├── font/
│   └── ...
└── other resource-pack files...
```

The important point is that `ui/` and `textures/` are directly inside the selected ZIP. Do not select a ZIP containing another folder that contains the actual pack unless that folder itself is the pack root.

## ZIP compatibility

The standalone reader supports normal ZIP entries using Store or Deflate compression. The exporter writes a standard Store-only ZIP for maximum compatibility.
