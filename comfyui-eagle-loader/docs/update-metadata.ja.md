# Eagle item の情報を更新する

Eagle にある既存 item のタグ、評価、注釈、フォルダなどを ComfyUI から変更できます。

最初は `Eagle Quick Update Item` を使うのがおすすめです。

## metadata_json とは

`Eagle Image Browser` などの読み込みノードは `metadata_json` を出力します。

これは Eagle item の情報が入った JSON 文字列です。item ID も含まれているため、更新ノードへ渡すと「どの item を更新するか」を指定できます。

## Eagle Quick Update Item

よく使う更新だけをまとめた簡易ノードです。

主な入力:

- `metadata_json`: 更新したい item の情報。
- `item_id`: `metadata_json` を使わず ID で指定したい場合に使います。
- `star`: 評価を設定します。`-1` は変更なしです。
- `tags_add_csv`: 追加するタグ。
- `tags_remove_csv`: 削除するタグ。
- `annotation_append`: 注釈に追記する文章。
- `folder`: 移動先フォルダ。空なら変更しません。
- `trash`: item を trash に移動します。
- `confirm_trash`: trash 操作の確認用です。

`trash` を使う場合は `confirm_trash` も有効にしてください。誤操作を防ぐためです。

## Eagle Update Item

詳細版の更新ノードです。

次のような場合に使います。

- タグを全置換したい。
- 注釈を全置換したい。
- star を toggle したい。
- フォルダを解除したい。
- 以前作った workflow の `item_json` 入力をそのまま使いたい。

通常のタグ追加、タグ削除、評価変更、注釈追記であれば `Eagle Quick Update Item` の方が扱いやすいです。

## 更新後の metadata_json

更新ノードの第1出力も `metadata_json` です。

そのため、更新後の情報をさらに別の Eagle metadata 系ノードへ渡せます。
