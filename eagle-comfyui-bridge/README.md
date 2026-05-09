# Eagle-ComfyUI Bridge

[日本語版 README](README.ja.md)

Eagle background-service plugin that exposes a local HTTP API for ComfyUI custom nodes. It is designed to be used with this repository's [ComfyUI Eagle Loader](../comfyui-eagle-loader).

## Features

- **Search API** for Eagle items with keyword, tag, folder, minimum rating, sort, limit, and offset.
- **Binary thumbnail API** with cache headers and item/path validation.
- **Binary original image API** for remote ComfyUI setups where local Eagle file paths are not accessible.
- **Metadata update API** for star, tags, annotation, folder move, and trash.
- **Folder/tag browsing** for gallery filters and node folder picker helpers.
- **Folder creation by path** when moving/sending items to a folder path such as `A/B/C`.
- **Folder delete endpoint** when the current Eagle API version exposes a delete/remove method.
- **Send endpoints** for adding images from URL or Base64.
- **Open in Eagle** endpoint.
- **SSE live notifications** for item changes and library changes when supported by the Eagle API.
- **Local by default**: binds to `127.0.0.1` unless configured otherwise.
- **Optional token protection** for write/protected endpoints.

## Installation

1. In Eagle, open `Plugins` -> `Developer` -> `Load Plugin from Folder`.
2. Select the `eagle-comfyui-bridge` folder.
3. The plugin starts as a background service.
4. Confirm the plugin UI shows the server as running.

The default API base is:

```text
http://127.0.0.1:8765/api
```

## Configuration

The plugin UI can configure:

- Port, default `8765`.
- Bind address, default `127.0.0.1`.
- Optional access token.

Security notes:

- Binding to `127.0.0.1` is recommended for local use.
- If binding to `0.0.0.0` or another non-localhost address, configure a token.
- Protected endpoints accept either:
  - `Authorization: Bearer <token>`
  - `X-Eagle-Bridge-Token: <token>`
  - `?token=<token>` where supported

## API Overview

All endpoints are under:

```text
http://127.0.0.1:8765/api
```

### Server Status

```http
GET /
```

Returns basic bridge status.

### Search

```http
GET /api/search?q=<query>&tags=<tag1,tag2>&folder=<folder_id>&min_rating=<0..5>&sort=<mode>&limit=<n>&offset=<n>
```

Parameters:

- `q`: keyword search.
- `tags`: comma-separated tags.
- `folder`: Eagle folder ID.
- `min_rating`: minimum star rating.
- `sort`: supported values include `default`, `star_desc`, `name_asc`, `name_desc`, `size_desc`.
- `limit`: page size. The bridge caps very large values.
- `offset`: zero-based offset.
- `annotation`: optional annotation text search.

Important behavior:

- Sorting and rating filtering happen before pagination.
- Results include `total`, allowing clients to address any item by offset without increasing `limit`.

Example response:

```json
{
  "results": [
    {
      "id": "item_id",
      "name": "image_name",
      "ext": "png",
      "width": 1024,
      "height": 1024,
      "tags": ["tag1", "tag2"],
      "annotation": "description",
      "filePath": "F:/library/images/item.info/image.png",
      "thumbnailPath": "F:/library/images/item.info/image_thumbnail.png",
      "size": 123456,
      "star": 5,
      "folders": ["folder_id"],
      "modifiedAt": 1700000000000
    }
  ],
  "count": 1,
  "total": 100
}
```

### Thumbnail JSON Compatibility Endpoint

```http
GET /api/thumbnail?id=<item_id>
```

Returns a Base64 thumbnail JSON payload. This endpoint is kept for compatibility; new clients should prefer `/api/thumbnail_image`.

### Thumbnail Image Bytes

```http
GET /api/thumbnail_image?id=<item_id>&max_size=<px>&format=<jpeg|png>&quality=<1..100>
```

Returns binary thumbnail bytes.

Headers include:

- `Content-Type`
- `ETag`
- `Cache-Control`
- `X-Eagle-Item-Id`
- `X-Eagle-Thumbnail-Path`
- `X-Eagle-Served-Path`
- `X-Eagle-Served-Source`
- `X-Eagle-Thumbnail-Mismatch`
- `X-Eagle-Request-Id`

The bridge validates that the served thumbnail or fallback media path belongs to the requested Eagle item. This prevents stale Eagle item data from causing adjacent-image thumbnail mix-ups.

### Original Image Bytes

```http
GET /api/image?id=<item_id>&max_size=<px>&format=<jpeg|png>&quality=<1..100>
```

Returns original image bytes, or a best-effort resized/encoded image when `max_size` is provided.

Notes:

- Without `max_size`, original bytes are streamed with `Cache-Control: no-store`.
- With resizing, cache revalidation uses `ETag`.
- The bridge validates that `filePath` belongs to the requested item.

### Item Details

```http
GET /api/get_image?id=<item_id>
```

Returns item metadata including paths, tags, annotation, dimensions, star, folders, and modified time.

### Open Item in Eagle

```http
POST /api/open
Content-Type: application/json

{ "id": "item_id" }
```

Also accepts `id` in the query string.

### Update Item

```http
POST /api/update_item
Content-Type: application/json

{
  "id": "item_id",
  "star": 5,
  "tags_add": ["review", "keep"],
  "tags_remove": "old-tag",
  "annotation_append": "Reviewed in ComfyUI",
  "folder": "A/B/C",
  "trash": false
}
```

Supported fields:

- `id` / `itemId`
- `toggle_star` / `toggleStar`
- `star`
- `tags_set` / `tagsSet`
- `tags_add` / `tagsAdd`
- `tags_remove` / `tagsRemove`
- `annotation_set` / `annotationSet`
- `annotation_append` / `annotationAppend`
- `folder` / `folderId` / `folder_id`
- `trash` / `moveToTrash`

Folder behavior:

- `folder` can be an existing folder ID or a path such as `A/B/C`.
- Missing folders in a path are created.
- Empty folder value clears folder assignment.

Trash behavior:

- `trash: true` calls Eagle's item trash operation.
- Clients should ask for confirmation before calling this endpoint.

### Delete Folder

```http
POST /api/folder_delete
Content-Type: application/json

{ "folder": "folder_id" }
```

The endpoint accepts an existing folder ID or path. It does not create missing folders while resolving the target.

This depends on the current Eagle API exposing a folder delete/remove method. If unsupported, the endpoint returns a 501 JSON error.

### Folders

```http
GET /api/folders
```

Response:

```json
{
  "folders": [
    {
      "id": "folder_id",
      "name": "Folder Name",
      "description": "",
      "parent": null,
      "path": "Parent/Folder Name"
    }
  ]
}
```

### Tags

```http
GET /api/tags
```

Response:

```json
{
  "tags": [
    {
      "name": "tag_name",
      "count": 42,
      "color": "#ff5733"
    }
  ]
}
```

### Stats

```http
GET /api/stats
```

Response:

```json
{
  "totalItems": 1234,
  "libraryName": "My Library",
  "libraryPath": "F:/lib3.library"
}
```

The Eagle public plugin API exposes current library information, but does not expose a documented command for switching libraries. The bridge detects library changes made in Eagle and notifies SSE clients.

### Live Events

```http
GET /api/events
```

Returns `text/event-stream`.

Event types:

- `hello`
- `items_changed`
- `library_changed`
- `live_unsupported`
- `bridge_error`

Implementation notes:

- Item polling only runs while at least one SSE client is connected.
- Some Eagle versions do not expose `eagle.item.getIdsWithModifiedAt()`. In that case the bridge emits `live_unsupported` and closes the stream.
- Library switching is detected through `eagle.onLibraryChanged(...)`.

## Send Endpoints

### Add From URL

```http
POST /api/add_from_url
Content-Type: application/json

{
  "url": "http://127.0.0.1:8188/api/view?filename=...&type=output&subfolder=...",
  "name": "optional_filename.png",
  "website": "optional source URL",
  "annotation": "optional long text",
  "tags": ["tag1", "tag2"],
  "folder": "FolderName or FolderPath (A/B/C) or FolderId"
}
```

Eagle pulls the file from the URL. This is recommended when ComfyUI and Eagle are on different machines, containers, or processes.

### Add From Base64

```http
POST /api/add_from_base64
Content-Type: application/json

{
  "base64": "data:image/png;base64,...",
  "name": "optional_filename.png",
  "website": "optional source URL",
  "annotation": "optional long text",
  "tags": ["tag1", "tag2"],
  "folder": "FolderName or FolderPath (A/B/C) or FolderId"
}
```

The bridge accepts large JSON bodies for this endpoint, but Base64 adds about 33% overhead. For large PNG/WebP images, URL mode is usually better.

## Usage With ComfyUI

1. Install and start this Eagle plugin.
2. Install this repository's [ComfyUI Eagle Loader](../comfyui-eagle-loader).
3. In ComfyUI, add `Eagle Image Browser`.
4. Click `Open Gallery` to browse/search and select images.

If a token is configured in this bridge, set `EAGLE_BRIDGE_TOKEN` in the ComfyUI environment.

## Troubleshooting

### Server will not start

- Check whether the configured port is already in use.
- If binding to non-localhost, configure a token.
- Restart Eagle after changing plugin settings.

### ComfyUI cannot connect

- Confirm Eagle is running.
- Confirm this plugin is active.
- Confirm the port matches `EAGLE_BRIDGE_API_BASE`.
- Confirm token configuration matches on both sides.

### Folder list is empty

- Confirm a library is open in Eagle.
- Try `GET /api/folders` in a browser or HTTP client.
- If Eagle was just switched to another library, refresh the ComfyUI gallery.

### Live updates unsupported

Your Eagle version may not expose `eagle.item.getIdsWithModifiedAt()`. The bridge and loader still work; live notify is simply disabled.

### Folder delete unsupported

The currently running Eagle API may not expose a folder delete/remove method. Use Eagle's UI for folder deletion in that case.

## Development

```text
eagle-comfyui-bridge/
├── manifest.json
├── index.html
├── server.js
├── logo.png
└── README.md
```

Basic tests:

```bash
curl http://127.0.0.1:8765/
curl "http://127.0.0.1:8765/api/search?limit=5"
curl http://127.0.0.1:8765/api/folders
curl http://127.0.0.1:8765/api/stats
```

After editing `server.js`, reload/restart the Eagle plugin.

## License

MIT License

## Related Projects

- [ComfyUI Eagle Loader](../comfyui-eagle-loader)
