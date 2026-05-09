# Eagle-ComfyUI Bridge API Reference

This page is for users who want to inspect or call the bridge API directly.

Normal ComfyUI workflows do not require direct API calls. The ComfyUI nodes call these endpoints automatically.

## Base URL

Default:

```text
http://127.0.0.1:8765/api
```

If an access token is configured, pass it with one of:

- `Authorization: Bearer <token>`
- `X-Eagle-Bridge-Token: <token>`
- `?token=<token>` on supported endpoints

## Common Endpoints

### Search

```http
GET /api/search
```

Searches Eagle library items.

Common query parameters:

- `q`: keyword.
- `tags`: comma-separated tags.
- `folder`: Eagle folder ID.
- `min_rating`: minimum star rating.
- `sort`: sort mode.
- `limit`: number of items.
- `offset`: starting offset.

### Get Item Details

```http
GET /api/get_image?id=<item_id>
```

Returns item ID, name, tags, annotation, rating, image path, thumbnail path, and related metadata.

### Thumbnail Image

```http
GET /api/thumbnail_image?id=<item_id>
```

Returns thumbnail image bytes.

### Original Image

```http
GET /api/image?id=<item_id>
```

Returns original image bytes. This is also used when ComfyUI cannot read Eagle's local file path directly.

### Open in Eagle

```http
POST /api/open
Content-Type: application/json

{ "id": "item_id" }
```

Opens the item in the Eagle UI.

### Update Item

```http
POST /api/update_item
Content-Type: application/json

{
  "id": "item_id",
  "star": 5,
  "tags_add": ["review"],
  "annotation_append": "Checked in ComfyUI",
  "folder": "A/B/C",
  "trash": false
}
```

Updates item metadata.

Common fields:

- `star`
- `toggle_star`
- `tags_set`
- `tags_add`
- `tags_remove`
- `annotation_set`
- `annotation_append`
- `folder`
- `trash`

`folder` accepts a folder ID or a path like `A/B/C`. Missing path folders are created when needed.

### Add From URL

```http
POST /api/add_from_url
Content-Type: application/json

{
  "url": "http://127.0.0.1:8188/api/view?filename=...",
  "name": "optional.png",
  "annotation": "optional text",
  "tags": ["tag1", "tag2"],
  "folder": "A/B/C"
}
```

Eagle fetches the image from the URL and adds it to the library.

### Add From Base64

```http
POST /api/add_from_base64
Content-Type: application/json

{
  "base64": "data:image/png;base64,...",
  "name": "optional.png",
  "tags": ["tag1", "tag2"]
}
```

Uploads image bytes as Base64. For large images, URL mode is usually lighter.

### Folders

```http
GET /api/folders
```

Returns Eagle folder list.

### Tags

```http
GET /api/tags
```

Returns Eagle tag list.

### Stats

```http
GET /api/stats
```

Returns basic current library information.

### Events

```http
GET /api/events
```

Streams library or item change notifications. ComfyUI uses this to show a refresh prompt.

## Notes

- The public Eagle plugin API does not expose a documented library-switch command.
- Folder deletion only works when the current Eagle API exposes a folder delete/remove method.
- Live events may be unavailable depending on Eagle version.

