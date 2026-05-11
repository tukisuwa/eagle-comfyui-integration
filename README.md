# Eagle ComfyUI Integration

[日本語版 README](README.ja.md)

This repository contains the two components needed to connect Eagle and ComfyUI.

- `eagle-comfyui-bridge/`: Eagle plugin. It runs a local bridge API inside Eagle.
- `comfyui-eagle-loader/`: ComfyUI custom nodes. They browse, load, update, and send Eagle items through the bridge.

Install both folders. The ComfyUI nodes need the Eagle bridge plugin to be running.

## Changelog

### 2026-05-11

- Added nested Eagle folder support. Folder pickers and move controls can now show and select child and grandchild folders as `Parent/Child/Grandchild` paths.
- Added the selected image's current folder to the browser details panel.

## What You Can Do

- Browse Eagle images from ComfyUI.
- Load selected Eagle images into ComfyUI workflows.
- Open an internal gallery with thumbnail search and filters.
- Edit Eagle item tags, rating, annotation, folder, and trash state.
- Load embedded ComfyUI workflows from Eagle images.
- Send ComfyUI output images back to Eagle.

## Repository Layout

```text
eagle-comfyui-integration/
├── eagle-comfyui-bridge/
│   ├── manifest.json
│   ├── index.html
│   └── server.js
├── comfyui-eagle-loader/
│   ├── nodes.py
│   ├── js/
│   └── docs/
└── README.md
```

## Install the Eagle Plugin

1. Open Eagle.
2. Open `Plugins` -> `Developer` -> `Load Plugin from Folder`.
3. Select this repository's `eagle-comfyui-bridge` folder.
4. Confirm the plugin UI shows the server is running.

Default bridge API:

```text
http://127.0.0.1:8765/api
```

## Install the ComfyUI Custom Nodes

Copy or symlink this repository's `comfyui-eagle-loader` folder into `ComfyUI/custom_nodes/`.

Then install Python dependencies:

```bash
cd ComfyUI/custom_nodes/comfyui-eagle-loader
pip install -r requirements.txt
```

Restart ComfyUI after installing or updating Python node files.

## First Check

1. Start Eagle and confirm the bridge plugin is running.
2. Start ComfyUI.
3. Add an `Eagle Image Browser` node.
4. Click `Open Gallery`.
5. Select an Eagle image and connect the node's `image` output to your workflow.

## Documentation

ComfyUI nodes:

- [ComfyUI Eagle Loader README](comfyui-eagle-loader/README.md)
- [ComfyUI Loader Documentation](comfyui-eagle-loader/docs/README.md)
- [日本語: ComfyUI Loader Documentation](comfyui-eagle-loader/docs/README.ja.md)

Eagle plugin:

- [Eagle-ComfyUI Bridge README](eagle-comfyui-bridge/README.md)
- [日本語: Eagle-ComfyUI Bridge README](eagle-comfyui-bridge/README.ja.md)

## Configuration

The default local setup usually needs no extra configuration.

Use environment variables only when changing the bridge URL or token:

```bash
export EAGLE_BRIDGE_API_BASE="http://127.0.0.1:8765/api"
export EAGLE_BRIDGE_TOKEN="optional-token-if-configured"
```

If you bind the Eagle bridge to a non-localhost address, set an access token.

## Recommended Starting Nodes

- Load images from Eagle: `Eagle Image Browser`
- Send ComfyUI images to Eagle: `Eagle Quick Send to Eagle`
- Update existing Eagle items: `Eagle Quick Update Item`
- Extract embedded workflows: `Eagle Extract Embedded Workflow`

## Related

- [Eagle](https://eagle.cool)
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
