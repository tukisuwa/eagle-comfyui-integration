# Setup and First Check

ComfyUI Eagle Loader is the ComfyUI-side custom node package. To access an Eagle library, the Eagle-side [Eagle-ComfyUI Bridge](../../eagle-comfyui-bridge) plugin from this repository must also be running.

You need both parts:

- ComfyUI side: `comfyui-eagle-loader`
- Eagle side: `eagle-comfyui-bridge`

## Install

Place this folder under `ComfyUI/custom_nodes/`, then install dependencies:

```bash
cd ComfyUI/custom_nodes/comfyui-eagle-loader
pip install -r requirements.txt
```

Restart ComfyUI after installation.

## Check Eagle

Start Eagle and make sure this repository's `eagle-comfyui-bridge` plugin is running.

The default bridge API is:

```text
http://127.0.0.1:8765/api
```

If Eagle and ComfyUI run on the same machine, the default usually works.

## Check ComfyUI

Open ComfyUI and look for the `Eagle` node category.

Create an `Eagle Image Browser` node. If the node shows an `Open Gallery` button, the frontend extension is loaded.

## Optional Environment Variables

Use these only when you need to change the bridge URL or token:

```bash
export EAGLE_BRIDGE_API_BASE="http://127.0.0.1:8765/api"
export EAGLE_BRIDGE_TOKEN="optional-token-if-configured"
```

Next, read [Browse and Load Images](browse-load.md).
