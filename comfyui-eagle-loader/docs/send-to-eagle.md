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
- `comfyui_public_url`: ComfyUI URL visible to Eagle.
- `file_format`: `png`, `jpeg`, or `webp`.

For a simple workflow, connect `images` and optionally set `eagle_folder` and `tags_csv`.

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

This is the URL Eagle uses to fetch images from ComfyUI.

If Eagle and ComfyUI run on the same machine, this usually works:

```text
http://127.0.0.1:8188
```

If they are on different machines, use a URL that Eagle can access.

