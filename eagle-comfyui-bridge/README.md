# Eagle-ComfyUI Bridge

[日本語版 README](README.ja.md)

Eagle-ComfyUI Bridge is the Eagle plugin used by [ComfyUI Eagle Loader](../comfyui-eagle-loader).

It starts a small local server inside Eagle. The ComfyUI nodes connect to that server to search, load, update, and send Eagle items.

## What It Does

- Searches Eagle library items.
- Sends thumbnails and original image bytes to ComfyUI.
- Updates item tags, rating, annotation, folder, and trash state.
- Adds ComfyUI output images to Eagle.
- Provides folder and tag lists for ComfyUI controls.

Most users do not need to call the API directly. The ComfyUI nodes use it automatically.

## Installation

1. Open Eagle.
2. Open `Plugins` -> `Developer` -> `Load Plugin from Folder`.
3. Select this repository's `eagle-comfyui-bridge` folder.
4. Confirm the plugin UI shows the server is running.

Default bridge URL:

```text
http://127.0.0.1:8765/api
```

## Basic Settings

The plugin UI lets you configure:

- port: usually keep `8765`.
- bind address: usually keep `127.0.0.1`.
- access token: use this for LAN or remote access.

If Eagle and ComfyUI run on the same machine, the default settings usually work.

## ComfyUI Side

This plugin does not add ComfyUI nodes by itself. Install this repository's [ComfyUI Eagle Loader](../comfyui-eagle-loader) under `ComfyUI/custom_nodes/`.

See [ComfyUI Loader Documentation](../comfyui-eagle-loader/docs/README.md) for node usage.

## Security

For local-only use, keep the bind address as `127.0.0.1`.

If you bind to `0.0.0.0` or another LAN-accessible address, set an access token. If a token is set, configure the same value in ComfyUI as `EAGLE_BRIDGE_TOKEN`.

## Troubleshooting

### ComfyUI Cannot Connect

- Confirm Eagle is running.
- Confirm the bridge plugin server is running.
- Confirm `EAGLE_BRIDGE_API_BASE` matches the bridge port.
- If a token is configured, confirm both sides use the same token.

### Port Is Already Used

Another app may be using `8765`. Change the port in the plugin UI, then update `EAGLE_BRIDGE_API_BASE` in ComfyUI.

### Folder or Tag Lists Are Empty

Confirm an Eagle library is open. If you just switched libraries, refresh the ComfyUI gallery.

## Detailed Documentation

- [API Reference](docs/api.md)
- [日本語 README](README.ja.md)

