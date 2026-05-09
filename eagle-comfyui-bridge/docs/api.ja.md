# Eagle-ComfyUI Bridge API リファレンス

このページは、bridge API を直接確認したい人向けの資料です。

通常の利用では、ComfyUI 側のノードが API を自動で呼び出すため、このページを読む必要はありません。

## Base URL

デフォルトでは次の URL で動作します。

```text
http://127.0.0.1:8765/api
```

token を設定している場合は、次のいずれかで渡します。

- `Authorization: Bearer <token>`
- `X-Eagle-Bridge-Token: <token>`
- 対応 endpoint では `?token=<token>`

## よく使う endpoint

### Search

```http
GET /api/search
```

Eagle ライブラリ内の item を検索します。

主な query:

- `q`: キーワード。
- `tags`: カンマ区切りタグ。
- `folder`: Eagle folder ID。
- `min_rating`: 最低 star。
- `sort`: sort mode。
- `limit`: 取得件数。
- `offset`: 取得開始位置。

### Get item details

```http
GET /api/get_image?id=<item_id>
```

item の ID、名前、タグ、注釈、評価、画像 path、サムネイル path などを返します。

### Thumbnail image

```http
GET /api/thumbnail_image?id=<item_id>
```

サムネイル画像の bytes を返します。

### Original image

```http
GET /api/image?id=<item_id>
```

元画像の bytes を返します。ComfyUI 側から Eagle の local path が読めない場合にも使われます。

### Open in Eagle

```http
POST /api/open
Content-Type: application/json

{ "id": "item_id" }
```

Eagle UI 上で指定 item を開きます。

### Update item

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

item の metadata を更新します。

主な field:

- `star`
- `toggle_star`
- `tags_set`
- `tags_add`
- `tags_remove`
- `annotation_set`
- `annotation_append`
- `folder`
- `trash`

`folder` には folder ID または `A/B/C` のような path を指定できます。存在しない path は必要に応じて作成されます。

### Add from URL

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

Eagle が URL から画像を取得してライブラリに追加します。

### Add from Base64

```http
POST /api/add_from_base64
Content-Type: application/json

{
  "base64": "data:image/png;base64,...",
  "name": "optional.png",
  "tags": ["tag1", "tag2"]
}
```

画像 bytes を Base64 で送って Eagle に追加します。大きい画像では URL 方式の方が軽くなりやすいです。

### Folders

```http
GET /api/folders
```

Eagle のフォルダ一覧を返します。

### Tags

```http
GET /api/tags
```

Eagle のタグ一覧を返します。

### Stats

```http
GET /api/stats
```

現在のライブラリの基本情報を返します。

### Events

```http
GET /api/events
```

ライブラリ変更や item 変更を通知する stream です。ComfyUI 側では、変更通知を受けたときに Refresh を促す用途で使います。

## 補足

- Eagle の public plugin API には、documented なライブラリ切り替え command はありません。
- フォルダ削除は Eagle API 側に削除 method がある環境でのみ動作します。
- live events は Eagle のバージョンによって利用できない場合があります。

