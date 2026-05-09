# Troubleshooting

## Gallery Shows Connection Error

Check:

- Eagle is running.
- Eagle-ComfyUI Bridge plugin is enabled.
- `EAGLE_BRIDGE_API_BASE` matches the bridge port.
- If a token is configured, `EAGLE_BRIDGE_TOKEN` matches it.

## Folder List Only Shows All

This can happen if ComfyUI starts before the bridge is reachable.

Try:

- Start Eagle and the bridge plugin.
- Reload the ComfyUI browser tab.
- Recreate or reopen the node.

## Load WF Cannot Find a Workflow

Check:

- The image contains ComfyUI workflow metadata.
- The selected item is the original image, not a thumbnail.
- Dragging the same Eagle image into ComfyUI works.

## Thumbnail or Image Looks Wrong

Refresh the gallery after changing Eagle libraries or editing items in Eagle.

## ComfyUI and Eagle Are on Different Machines

For loading, the bridge can provide image bytes when local file paths are not readable.

For sending, set `comfyui_public_url` to a ComfyUI URL that Eagle can access.

## Python Node Changes Do Not Appear

Restart ComfyUI.

## JavaScript Changes Do Not Appear

Reload the ComfyUI browser tab. If node definitions also changed, restart ComfyUI.

