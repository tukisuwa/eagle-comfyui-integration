# Send ComfyUI Images to Eagle

Use send nodes when you want to save generated ComfyUI images into Eagle.

Start with `Eagle Quick Send to Eagle`.

## Eagle Quick Send to Eagle

This quick node exposes the common settings:

- `images`: images to send.
- `eagle_folder`: destination folder in Eagle.
- `name`: display name.
- `annotation`: item annotation.
- `tags_csv`: comma-separated tags.
- `eagle_meta_json`: metadata from another node.
- `send_method`: transfer method. Use `addFromPath (local)` for the normal local setup.
- `comfyui_public_url`: only used by `addFromURL (pull)`.
- `eagle_native_url`: Eagle's normal API URL. Usually `http://127.0.0.1:41595`.
- `eagle_token`: only needed when the Eagle API uses a token.
- `file_format`: `png`, `jpeg`, or `webp`.

For a simple workflow, connect `images` and optionally set `eagle_folder` and `tags_csv`.

Think of the transfer methods as a priority order:

- `addFromPath (local)`: recommended when Eagle and ComfyUI run on the same machine. It sends Eagle the saved local image path.
- `addFromURL (pull)`: use this when Eagle and ComfyUI are in different environments and Eagle can access the ComfyUI URL.
- `addFromBase64 (push)`: fallback when URL pull is not available. It can be slower for large images.

## Eagle Simple Send Info

This node builds a small `eagle_meta_json` payload that can be reused by send nodes.

Use it when you want to define folder, name, annotation, tags, or website separately from the image send node.

## Eagle Send to Eagle

Use the full send node when you need:

- Eagle Native API mode.
- Explicit URL pull or Base64 push.
- Custom bridge URL or token per node.
- Prompt-derived tags.
- JPEG/WebP quality tuning.
- Base64 threshold control.

## comfyui_public_url

`comfyui_public_url` is needed when using `addFromURL (pull)`.

This is the URL Eagle uses to fetch images from ComfyUI.

If Eagle and ComfyUI run on the same machine, this usually works:

```text
http://127.0.0.1:8188
```

If they are on different machines, use a URL that Eagle can access.
