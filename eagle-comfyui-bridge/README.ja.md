# Eagle-ComfyUI Bridge

Eagle-ComfyUI Bridge は、Eagle と ComfyUI をつなぐための Eagle plugin です。

同じリポジトリ内の [ComfyUI Eagle Loader](../comfyui-eagle-loader) から Eagle ライブラリへアクセスするために使います。

## 何をする plugin か

この plugin は Eagle の中で小さなローカル server を起動します。ComfyUI 側のノードは、その server に接続して Eagle の画像や metadata を扱います。

主に次のことを行います。

- Eagle ライブラリ内の画像を検索する。
- サムネイルや元画像を ComfyUI 側へ渡す。
- item のタグ、評価、注釈、フォルダ、trash を更新する。
- ComfyUI で生成した画像を Eagle に追加する。
- Eagle 側のフォルダやタグ一覧を ComfyUI 側へ渡す。

通常、ユーザーが直接 API を操作する必要はありません。ComfyUI 側の `Eagle Image Browser` や `Eagle Quick Send to Eagle` から自動的に使われます。

## インストール

1. Eagle を開きます。
2. `プラグイン` -> `開発者オプション...` -> `ローカルプロジェクトをインポート` を開きます。
3. このリポジトリ内の `eagle-comfyui-bridge` フォルダを選択します。
4. plugin 画面で server が running になっていることを確認します。

デフォルトの接続先は次です。

```text
http://127.0.0.1:8765/api
```

## 基本設定

plugin 画面で次の項目を設定できます。

- port: 通常は `8765` のままで問題ありません。
- bind address: 通常は `127.0.0.1` のまま使います。
- access token: LAN や別PCから接続する場合に設定します。

同じ PC 上で Eagle と ComfyUI を使う場合は、基本的に追加設定なしで動きます。

## ComfyUI 側の準備

この plugin だけでは ComfyUI にノードは追加されません。  
同じリポジトリ内の [ComfyUI Eagle Loader](../comfyui-eagle-loader) も `ComfyUI/custom_nodes/` にインストールしてください。

ComfyUI 側の詳しい使い方は [ComfyUI Loader ドキュメント](../comfyui-eagle-loader/docs/README.ja.md) を参照してください。

## セキュリティ

ローカルPCだけで使う場合は、`127.0.0.1` に bind する設定を推奨します。

`0.0.0.0` など LAN からアクセスできる設定にする場合は、access token を設定してください。token を設定した場合は、ComfyUI 側にも同じ token を `EAGLE_BRIDGE_TOKEN` として設定します。

## 困ったとき

### ComfyUI から接続できない

- Eagle が起動しているか確認してください。
- plugin 画面で server が running か確認してください。
- ComfyUI 側の `EAGLE_BRIDGE_API_BASE` が bridge の port と一致しているか確認してください。
- token を使っている場合は、Eagle 側と ComfyUI 側で同じ token になっているか確認してください。

### port が使えない

別のアプリが `8765` を使っている可能性があります。plugin 画面で port を変更し、ComfyUI 側の `EAGLE_BRIDGE_API_BASE` も同じ port に変更してください。

### フォルダ一覧やタグ一覧が出ない

Eagle でライブラリが開かれているか確認してください。ライブラリを切り替えた直後は、ComfyUI 側のギャラリーを Refresh してください。

## 詳細ドキュメント

- [API リファレンス](docs/api.ja.md)
- [English README](README.md)

