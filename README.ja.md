# Eagle ComfyUI Integration

このリポジトリは、Eagle と ComfyUI を連携するための2つのコンポーネントをまとめたものです。

- `eagle-comfyui-bridge/`: Eagle plugin。Eagle 内でローカル bridge API を起動します。
- `comfyui-eagle-loader/`: ComfyUI custom nodes。bridge 経由で Eagle の画像を検索、読み込み、更新、送信します。

両方をインストールしてください。ComfyUI 側のノードは、Eagle 側の bridge plugin が動いている状態で使います。

## 更新履歴

### 2026-05-11

- Eagle の階層フォルダを `親/子/孫` のようなパス付きで扱えるようにしました。ブラウザのフォルダ選択や移動先選択で、子フォルダや孫フォルダも選べます。
- ブラウザの詳細パネルに、選択中画像の現在のフォルダを表示するようにしました。

## できること

- ComfyUI から Eagle の画像を探す。
- Eagle の画像を ComfyUI workflow に読み込む。
- サムネイル付きギャラリーで検索、フィルタ、選択を行う。
- Eagle item のタグ、評価、注釈、フォルダ、trash を編集する。
- Eagle 画像に埋め込まれた ComfyUI workflow を読み込む。
- ComfyUI の出力画像を Eagle に送る。

## リポジトリ構成

```text
eagle-comfyui-integration/
├── eagle-comfyui-bridge/
│   ├── manifest.json
│   ├── index.html
│   └── server.js
├── comfyui-eagle-loader/
│   ├── nodes.py
│   ├── js/
│   └── docs/
└── README.md
```

## Eagle plugin のインストール

1. Eagle を開きます。
2. `プラグイン` -> `開発者オプション...` -> `ローカルプロジェクトをインポート` を開きます。
3. このリポジトリ内の `eagle-comfyui-bridge` フォルダを選択します。
4. plugin UI で server が running になっていることを確認します。

デフォルトの bridge API:

```text
http://127.0.0.1:8765/api
```

## ComfyUI custom nodes のインストール

このリポジトリ内の `comfyui-eagle-loader` フォルダを `ComfyUI/custom_nodes/` にコピー、または symlink します。

その後、Python 依存をインストールします。

```bash
cd ComfyUI/custom_nodes/comfyui-eagle-loader
pip install -r requirements.txt
```

インストール後、または Python ノードファイルを更新した後は ComfyUI を再起動してください。

## 最初の確認

1. Eagle を起動し、bridge plugin が running であることを確認します。
2. ComfyUI を起動します。
3. `Eagle Image Browser` ノードを追加します。
4. `Open Gallery` を押します。
5. Eagle の画像を選び、ノードの `image` 出力を workflow に接続します。

## ドキュメント

ComfyUI nodes:

- [ComfyUI Eagle Loader README](comfyui-eagle-loader/README.ja.md)
- [ComfyUI Loader ドキュメント](comfyui-eagle-loader/docs/README.ja.md)
- [English: ComfyUI Loader Documentation](comfyui-eagle-loader/docs/README.md)

Eagle plugin:

- [Eagle-ComfyUI Bridge README](eagle-comfyui-bridge/README.ja.md)
- [English: Eagle-ComfyUI Bridge README](eagle-comfyui-bridge/README.md)

## 設定

同じ PC で Eagle と ComfyUI を使う通常構成では、追加設定なしで動くことが多いです。

bridge URL や token を変更する場合だけ環境変数を使います。

```bash
export EAGLE_BRIDGE_API_BASE="http://127.0.0.1:8765/api"
export EAGLE_BRIDGE_TOKEN="bridge側で設定したtoken"
```

Eagle bridge を localhost 以外に bind する場合は、access token を設定してください。

## 最初に使うおすすめノード

- Eagle 画像を読み込む: `Eagle Image Browser`
- ComfyUI 画像を Eagle に送る: `Eagle Quick Send to Eagle`
- 既存 Eagle item を更新する: `Eagle Quick Update Item`
- 埋め込み workflow を取り出す: `Eagle Extract Embedded Workflow`

## 関連

- [Eagle](https://eagle.cool)
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
