# Eagle-ComfyUI Bridge

ComfyUI custom node から Eagle ライブラリにアクセスするための Eagle background service plugin です。同じリポジトリ内の [ComfyUI Eagle Loader](../comfyui-eagle-loader) と組み合わせて使います。

## 主な機能

- **検索 API**: keyword、tag、folder、最低評価、sort、limit、offset に対応。
- **binary thumbnail API**: cache header と item/path 検証付きでサムネイル bytes を返します。
- **binary image API**: ComfyUI 側から Eagle の local path が読めない場合に元画像 bytes を返します。
- **metadata update API**: star、tag、annotation、folder move、trash に対応。
- **folder/tag API**: ギャラリー filter やノードの folder picker で使用します。
- **folder path 作成**: `A/B/C` のような path を指定すると、必要に応じてフォルダを作成します。
- **folder delete endpoint**: Eagle API が対応している場合、フォルダ削除を行います。
- **send endpoint**: URL または Base64 から Eagle に item を追加します。
- **Open in Eagle**: item を Eagle UI で開きます。
- **SSE live notify**: 対応 API がある場合、item 変更や library 変更を通知します。
- **localhost default**: デフォルトでは `127.0.0.1` に bind します。
- **任意 token**: write/protected endpoint を token で保護できます。

## インストール

1. Eagle で `プラグイン` -> `開発者オプション...` -> `ローカルプロジェクトをインポート` を開きます。
2. `eagle-comfyui-bridge` フォルダを選択します。
3. plugin が background service として起動します。
4. plugin UI で server が running になっていることを確認します。

デフォルト API base:

```text
http://127.0.0.1:8765/api
```

## 設定

plugin UI で以下を設定できます。

- port。デフォルトは `8765`。
- bind address。デフォルトは `127.0.0.1`。
- optional access token。

セキュリティ:

- ローカル利用では `127.0.0.1` bind を推奨します。
- `0.0.0.0` など localhost 以外へ bind する場合は token を設定してください。
- protected endpoint は以下のいずれかで token を受け付けます。
  - `Authorization: Bearer <token>`
  - `X-Eagle-Bridge-Token: <token>`
  - 対応 endpoint では `?token=<token>`

## API

すべての endpoint は以下の base URL 配下です。

```text
http://127.0.0.1:8765/api
```

### Server Status

```http
GET /
```

bridge の基本 status を返します。

### Search

```http
GET /api/search?q=<query>&tags=<tag1,tag2>&folder=<folder_id>&min_rating=<0..5>&sort=<mode>&limit=<n>&offset=<n>
```

主な parameter:

- `q`: keyword search。
- `tags`: カンマ区切り tag。
- `folder`: Eagle folder ID。
- `min_rating`: 最低 star。
- `sort`: `default`、`star_desc`、`name_asc`、`name_desc`、`size_desc` など。
- `limit`: page size。極端に大きい値は bridge 側で制限されます。
- `offset`: 0 始まり offset。
- `annotation`: annotation text search。

挙動:

- sort と rating filter は pagination 前に適用されます。
- response には `total` が含まれます。client は `limit` を増やさず任意 offset の item を取得できます。

例:

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

### Thumbnail JSON compatibility

```http
GET /api/thumbnail?id=<item_id>
```

Base64 thumbnail JSON を返します。互換用 endpoint なので、新規 client は `/api/thumbnail_image` を推奨します。

### Thumbnail image bytes

```http
GET /api/thumbnail_image?id=<item_id>&max_size=<px>&format=<jpeg|png>&quality=<1..100>
```

binary thumbnail bytes を返します。

主な header:

- `Content-Type`
- `ETag`
- `Cache-Control`
- `X-Eagle-Item-Id`
- `X-Eagle-Thumbnail-Path`
- `X-Eagle-Served-Path`
- `X-Eagle-Served-Source`
- `X-Eagle-Thumbnail-Mismatch`
- `X-Eagle-Request-Id`

bridge は、返す thumbnail または fallback media path が要求された item に属するかを検証します。これにより Eagle API の stale item data による隣接画像のサムネイル取り違えを防ぎます。

### Original image bytes

```http
GET /api/image?id=<item_id>&max_size=<px>&format=<jpeg|png>&quality=<1..100>
```

元画像 bytes を返します。`max_size` 指定時は best-effort で resize/encode します。

補足:

- `max_size` なしでは original bytes を `Cache-Control: no-store` で stream します。
- resize 時は `ETag` による cache revalidation を使います。
- `filePath` が要求 item に属するか検証します。

### Item details

```http
GET /api/get_image?id=<item_id>
```

item metadata、path、tag、annotation、寸法、star、folder、modified time などを返します。

### Open item in Eagle

```http
POST /api/open
Content-Type: application/json

{ "id": "item_id" }
```

query string の `id` も受け付けます。

### Update item

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

対応 field:

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

Folder:

- `folder` は既存 folder ID または `A/B/C` のような path を受け付けます。
- path 内の存在しない folder は作成されます。
- 空の folder 値は folder assignment を解除します。

Trash:

- `trash: true` は Eagle の item trash 操作を呼びます。
- client 側で確認 UI を出してから呼ぶことを推奨します。

### Delete folder

```http
POST /api/folder_delete
Content-Type: application/json

{ "folder": "folder_id" }
```

既存 folder ID または path を受け付けます。削除対象の解決時には存在しない folder を作成しません。

現在の Eagle API が folder delete/remove method を提供していない場合、501 JSON error を返します。

### Folders

```http
GET /api/folders
```

例:

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

例:

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

例:

```json
{
  "totalItems": 1234,
  "libraryName": "My Library",
  "libraryPath": "F:/lib3.library"
}
```

Eagle の public plugin API は現在の library 情報取得には対応していますが、documented な library 切り替え command は提供していません。bridge は Eagle 側で行われた library 切り替えを検知して SSE client に通知します。

### Live events

```http
GET /api/events
```

`text/event-stream` を返します。

event type:

- `hello`
- `items_changed`
- `library_changed`
- `live_unsupported`
- `bridge_error`

補足:

- item polling は SSE client が 1 つ以上接続されている間だけ行います。
- Eagle のバージョンによっては `eagle.item.getIdsWithModifiedAt()` が無く、その場合は `live_unsupported` を送って stream を閉じます。
- library switching は `eagle.onLibraryChanged(...)` で検知します。

## Send endpoints

### Add from URL

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

Eagle が URL から画像を取得します。ComfyUI と Eagle が別 machine/container/process の場合に推奨です。

### Add from Base64

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

Base64 は約 33% サイズが増えます。大きい PNG/WebP では URL mode の方が向いています。

## ComfyUI との使い方

1. この Eagle plugin をインストールして起動します。
2. 同じリポジトリ内の [ComfyUI Eagle Loader](../comfyui-eagle-loader) をインストールします。
3. ComfyUI で `Eagle Image Browser` ノードを追加します。
4. `Open Gallery` で検索・選択します。

bridge に token を設定している場合は、ComfyUI 側の環境変数 `EAGLE_BRIDGE_TOKEN` も設定してください。

## トラブルシューティング

### server が起動しない

- port が他プロセスに使われていないか確認してください。
- localhost 以外へ bind する場合は token を設定してください。
- plugin 設定変更後は Eagle を再起動してください。

### ComfyUI から接続できない

- Eagle が起動しているか確認してください。
- plugin が active か確認してください。
- `EAGLE_BRIDGE_API_BASE` の port が一致しているか確認してください。
- token の設定が両側で一致しているか確認してください。

### folder list が空

- Eagle で library が開かれているか確認してください。
- ブラウザや HTTP client で `GET /api/folders` を試してください。
- Eagle 側で library を切り替えた直後は ComfyUI gallery を Refresh してください。

### Live updates unsupported

Eagle のバージョンが `eagle.item.getIdsWithModifiedAt()` を提供していない可能性があります。bridge と loader の通常機能は使えますが、live notify は無効になります。

### Folder delete unsupported

実行中の Eagle API が folder delete/remove method を提供していない可能性があります。その場合は Eagle UI 側で削除してください。

## 開発

```text
eagle-comfyui-bridge/
├── manifest.json
├── index.html
├── server.js
├── logo.png
└── README.md
```

簡単な動作確認:

```bash
curl http://127.0.0.1:8765/
curl "http://127.0.0.1:8765/api/search?limit=5"
curl http://127.0.0.1:8765/api/folders
curl http://127.0.0.1:8765/api/stats
```

`server.js` を変更した場合は Eagle plugin を reload/restart してください。

## 関連

- [ComfyUI Eagle Loader](../comfyui-eagle-loader)
