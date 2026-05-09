# 困ったときの確認

よくある問題と確認ポイントです。

## Gallery が connection error になる

Eagle 側の bridge plugin に接続できていない可能性があります。

確認すること:

- Eagle が起動しているか。
- Eagle-ComfyUI Bridge plugin が有効か。
- bridge API の port が `EAGLE_BRIDGE_API_BASE` と一致しているか。
- token を設定している場合、ComfyUI 側の `EAGLE_BRIDGE_TOKEN` も同じか。

## folder_filter が All しかない

ComfyUI 起動時に Eagle 側へ接続できなかった場合、Python 側の初期選択肢は `All` だけになることがあります。

対処:

- Eagle と bridge plugin を起動する。
- ComfyUI のブラウザタブを reload する。
- ノードを作り直すか、開き直す。

現在の JS 拡張は、bridge に接続できるようになった後でフォルダ一覧を更新します。

## Load WF で workflow が読み込めない

確認すること:

- その画像に ComfyUI workflow が埋め込まれているか。
- Eagle から同じ画像を ComfyUI に直接ドラッグした場合に workflow が読めるか。
- 選択している画像がサムネイルではなく元画像か。

## サムネイルや画像が違って見える

ギャラリーを Refresh してください。

Eagle 側でライブラリを切り替えた場合や、Eagle 側の item が更新された場合、表示と実体の同期が必要になることがあります。

## ComfyUI と Eagle が別の PC にある

ComfyUI から Eagle のローカル file path が読めない場合、bridge 経由で画像 bytes を取得します。

送信時の `comfyui_public_url` は、Eagle からアクセスできる ComfyUI の URL にしてください。

## Python ノードの変更が反映されない

ComfyUI を再起動してください。

`nodes.py` のような Python ノード定義は、ComfyUI 起動時に読み込まれます。

## JavaScript の変更が反映されない

ComfyUI のブラウザタブを reload してください。

それでも変わらない場合は、ComfyUI の再起動やブラウザ cache の確認も必要です。

