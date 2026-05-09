# ComfyUI の画像を Eagle に送る

ComfyUI で生成した画像を Eagle に保存したい場合は、送信用ノードを使います。

最初は `Eagle Quick Send to Eagle` がおすすめです。

## Eagle Quick Send to Eagle

よく使う設定だけを持つ簡易送信ノードです。

主な入力:

- `images`: Eagle に送る画像。
- `eagle_folder`: Eagle の保存先フォルダ。
- `name`: Eagle 上での表示名。
- `annotation`: Eagle item の注釈。
- `tags_csv`: カンマ区切りタグ。
- `eagle_meta_json`: 別ノードで作った送信用 metadata。
- `send_method`: 送信方式。通常は `addFromPath (local)` を使います。
- `comfyui_public_url`: `addFromURL (pull)` のときだけ使います。
- `eagle_native_url`: Eagle の通常 API URL。通常は `http://127.0.0.1:41595` です。
- `eagle_token`: Eagle API に token を設定している場合だけ入力します。
- `file_format`: `png`、`jpeg`、`webp`。

通常は `images` をつなぎ、必要なら `eagle_folder` と `tags_csv` を設定するだけで使えます。

送信方式は優先順位で考えると分かりやすいです。

- `addFromPath (local)`: Eagle と ComfyUI が同じ PC で動いている場合におすすめです。ComfyUI が保存した画像ファイルの path を Eagle に渡します。
- `addFromURL (pull)`: Eagle と ComfyUI が別環境で、Eagle から ComfyUI の URL を読める場合に使います。
- `addFromBase64 (push)`: URL で取りに行けない場合の fallback です。大きい画像では遅くなることがあります。

## Eagle Simple Send Info

送信用の metadata JSON を作る簡易ノードです。

例えば、複数の送信ノードで同じタグやフォルダを使いたい場合に便利です。

出力の `eagle_meta_json` を `Eagle Quick Send to Eagle` または `Eagle Send to Eagle` に渡します。

## Eagle Send to Eagle

詳細版の送信ノードです。

次のような場合に使います。

- Eagle Native API を使いたい。
- URL pull と Base64 push を明示的に選びたい。
- bridge URL や token をノードごとに変えたい。
- prompt をタグとして保存したい。
- JPEG/WebP の品質を細かく調整したい。

普通の保存だけなら `Eagle Quick Send to Eagle` で十分です。

## フォルダ指定

フォルダ入力には補助 Combo が付きます。Eagle 側のフォルダ一覧から選べます。

文字列入力も残っているので、フォルダ ID や `親/子/孫` のような path を直接入力することもできます。

## comfyui_public_url について

`comfyui_public_url` は `addFromURL (pull)` 方式を使う場合に必要です。

Eagle が ComfyUI の画像を取りに行くための URL です。

Eagle と ComfyUI が同じ PC で動いている場合は、通常は次で問題ありません。

```text
http://127.0.0.1:8188
```

別の PC で動かしている場合は、Eagle からアクセスできる ComfyUI の URL を指定してください。
