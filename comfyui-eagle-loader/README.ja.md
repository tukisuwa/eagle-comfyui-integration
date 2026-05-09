# ComfyUI Eagle Loader

ComfyUI から Eagle ライブラリ内の画像を検索、閲覧、読み込み、更新、送信するためのカスタムノードです。

この README は入口用のページです。詳しい使い方は `docs/` 配下の説明書に分けています。

## できること

- Eagle の画像を ComfyUI ノードから読み込む。
- ブラウザ UI で Eagle ライブラリを検索し、サムネイルを見ながら選択する。
- 選択画像のタグ、評価、注釈、フォルダ、trash を編集する。
- Eagle 画像に埋め込まれた ComfyUI workflow を読み込む。
- ComfyUI で生成した画像を Eagle に送る。

## 必要なもの

- Eagle
- ComfyUI
- 同じリポジトリ内の companion plugin: [Eagle-ComfyUI Bridge](../eagle-comfyui-bridge)

Eagle 側の bridge plugin が起動していないと、このカスタムノードは Eagle ライブラリへアクセスできません。

## インストール

1. このフォルダを `ComfyUI/custom_nodes/` 以下に配置します。
2. Python 依存をインストールします。

```bash
cd ComfyUI/custom_nodes/comfyui-eagle-loader
pip install -r requirements.txt
```

3. ComfyUI を再起動します。
4. Eagle を起動し、このリポジトリ内の `eagle-comfyui-bridge` plugin が動作していることを確認します。

## 設定

通常は bridge API が `http://127.0.0.1:8765/api` で動作していれば追加設定は不要です。

必要に応じて環境変数で変更できます。

```bash
export EAGLE_BRIDGE_API_BASE="http://127.0.0.1:8765/api"
export EAGLE_BRIDGE_TOKEN="bridge側で設定したtoken"
export EAGLE_LOADER_DEBUG="0"
```

## ドキュメント

- [ドキュメント一覧](docs/README.ja.md)
- [導入と最初の確認](docs/setup.ja.md)
- [画像を探して読み込む](docs/browse-load.ja.md)
- [ComfyUI の画像を Eagle に送る](docs/send-to-eagle.ja.md)
- [Eagle item の情報を更新する](docs/update-metadata.ja.md)
- [埋め込み workflow と metadata を扱う](docs/workflow-metadata.ja.md)
- [困ったときの確認](docs/troubleshooting.ja.md)

## ノードの大まかな分類

- 読み込み: `Eagle Image Browser`、`Eagle Image by ID`、`Eagle Random Image`
- Eagle へ送信: `Eagle Quick Send to Eagle`、`Eagle Send to Eagle`
- 送信用 metadata 作成: `Eagle Simple Send Info`、`Eagle Build Send Info`
- 既存 item の更新: `Eagle Quick Update Item`、`Eagle Update Item`
- workflow 抽出: `Eagle Extract Embedded Workflow`

最初は `Eagle Image Browser` と `Eagle Quick Send to Eagle` から使うのがおすすめです。

## 関連

- [Eagle-ComfyUI Bridge](../eagle-comfyui-bridge)
- [English README](README.md)
