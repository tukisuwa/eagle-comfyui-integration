# 導入と最初の確認

このページでは、ComfyUI Eagle Loader を使い始めるために必要な準備を説明します。

## 役割の整理

ComfyUI Eagle Loader は ComfyUI 側のカスタムノードです。  
ただし、Eagle のライブラリへ直接アクセスするためには Eagle 側で同じリポジトリ内の [Eagle-ComfyUI Bridge](../../eagle-comfyui-bridge) plugin が動いている必要があります。

つまり、次の2つを両方使います。

- ComfyUI 側: `comfyui-eagle-loader`
- Eagle 側: `eagle-comfyui-bridge`

## インストール

`comfyui-eagle-loader` フォルダを `ComfyUI/custom_nodes/` の下に置きます。

その後、依存パッケージを入れます。

```bash
cd ComfyUI/custom_nodes/comfyui-eagle-loader
pip install -r requirements.txt
```

インストール後は ComfyUI を再起動してください。Python ノード定義は ComfyUI 起動時に読み込まれます。

## Eagle 側の確認

Eagle を起動し、このリポジトリ内の `eagle-comfyui-bridge` plugin が動いていることを確認します。

通常の bridge API は次の場所です。

```text
http://127.0.0.1:8765/api
```

ComfyUI と Eagle が同じ PC 上で動いているなら、多くの場合はこのままで使えます。

## ComfyUI 側の確認

ComfyUI を開き、ノード追加メニューから `Eagle` カテゴリを探します。

最初に確認するノードは `Eagle Image Browser` です。ノードを置いて `Open Gallery` ボタンが表示されれば、ComfyUI 側の JavaScript も読み込まれています。

## 環境変数

bridge の URL や token を変えたい場合だけ環境変数を使います。

```bash
export EAGLE_BRIDGE_API_BASE="http://127.0.0.1:8765/api"
export EAGLE_BRIDGE_TOKEN="bridge側で設定したtoken"
```

通常は設定しなくても使えます。

## 次に読む

画像を読み込む基本操作は [画像を探して読み込む](browse-load.ja.md) を読んでください。
