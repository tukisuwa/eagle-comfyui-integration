# ComfyUI Eagle Loader

[日本語版 README](README.ja.md)

Custom nodes for browsing, loading, updating, and sending Eagle library images from ComfyUI.

This README is a portal. Detailed beginner-friendly guides are split under `docs/`.

## What It Does

- Load Eagle library images into ComfyUI.
- Browse Eagle with an interactive gallery and thumbnails.
- Edit item tags, rating, annotation, folder, and trash state.
- Load embedded ComfyUI workflows from Eagle images.
- Send ComfyUI output images to Eagle.

## Requirements

- Eagle
- ComfyUI
- Companion plugin in this repository: [Eagle-ComfyUI Bridge](../eagle-comfyui-bridge)

The Eagle bridge plugin must be running before these nodes can access your Eagle library.

## Installation

1. Put this folder under `ComfyUI/custom_nodes/`.
2. Install Python dependencies:

```bash
cd ComfyUI/custom_nodes/comfyui-eagle-loader
pip install -r requirements.txt
```

3. Restart ComfyUI.
4. Start Eagle and confirm this repository's `eagle-comfyui-bridge` plugin is running.

## Configuration

The default bridge API is:

```text
http://127.0.0.1:8765/api
```

Optional environment variables:

```bash
export EAGLE_BRIDGE_API_BASE="http://127.0.0.1:8765/api"
export EAGLE_BRIDGE_TOKEN="optional-token-if-configured"
export EAGLE_LOADER_DEBUG="0"
```

## Documentation

- [Documentation Index](docs/README.md)
- [Setup and First Check](docs/setup.md)
- [Browse and Load Images](docs/browse-load.md)
- [Send ComfyUI Images to Eagle](docs/send-to-eagle.md)
- [Update Eagle Item Metadata](docs/update-metadata.md)
- [Embedded Workflows and Metadata](docs/workflow-metadata.md)
- [Troubleshooting](docs/troubleshooting.md)

## Node Groups

- Load from Eagle: `Eagle Image Browser`, `Eagle Image by ID`, `Eagle Random Image`
- Send to Eagle: `Eagle Quick Send to Eagle`, `Eagle Send to Eagle`
- Build send metadata: `Eagle Simple Send Info`, `Eagle Build Send Info`
- Update existing items: `Eagle Quick Update Item`, `Eagle Update Item`
- Extract workflow metadata: `Eagle Extract Embedded Workflow`

Start with `Eagle Image Browser` and `Eagle Quick Send to Eagle` for most workflows.

## Related

- [Eagle-ComfyUI Bridge](../eagle-comfyui-bridge)
- [Eagle App](https://eagle.cool)
