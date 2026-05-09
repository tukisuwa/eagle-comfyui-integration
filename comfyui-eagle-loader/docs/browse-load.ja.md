# 画像を探して読み込む

Eagle ライブラリから画像を探して ComfyUI に読み込む場合は、まず `Eagle Image Browser` を使います。

## Eagle Image Browser

このノードは、Eagle 内の画像を検索し、選んだ画像を ComfyUI の `IMAGE` として出力します。

主な出力は次の3つです。

- `image`: ComfyUI で使う画像。
- `file_path`: Eagle 側の元画像パス。環境によっては空になることがあります。
- `metadata_json`: Eagle item の情報。ID、名前、タグ、評価、注釈、画像サイズなどが入ります。

`metadata_json` は後続の `Eagle Quick Update Item` や `Eagle Extract Embedded Workflow` に渡せます。

## ギャラリーで選ぶ

ノード上の `Open Gallery` を押すと、ブラウザ UI が開きます。

ギャラリーでは次の操作ができます。

- キーワードで検索する。
- タグで絞り込む。
- フォルダで絞り込む。
- star 評価で絞り込む。
- サムネイルを見ながら画像を選ぶ。
- 元画像をビューアで開く。
- Eagle 側で item を開く。
- 埋め込み workflow を読み込む。

画像を選ぶと、ノードの `selected_index` と `selected_item_json` が更新されます。通常はこの値を手で編集する必要はありません。

## ノード上で index 指定する

`selected_index` は検索結果内の番号です。0 が最初の画像です。

検索条件を変えると、同じ `selected_index` でも別の画像を指すことがあります。特定の画像を選びたい場合は、ギャラリーから選択するのが安全です。

## index_mode

`index_mode` は、ノード実行後に次回の `selected_index` をどう変えるかを決めます。

- `fixed`: 同じ index を使い続けます。
- `increment`: 実行ごとに次の画像へ進みます。
- `decrement`: 実行ごとに前の画像へ戻ります。
- `random`: 次回用の index をランダムに選びます。

連続生成で Eagle の画像を順番に使いたい場合は `increment` が便利です。

## index_overflow

`selected_index` が検索結果数を超えた場合の動きです。

- `loop`: 先頭に戻ります。通常はこれがおすすめです。
- `placeholder`: placeholder 画像を出します。
- `error`: エラーにします。

## 補助読み込みノード

### Eagle Image by ID

Eagle item ID が分かっている場合に、その item を直接読み込みます。

普通に画像を探して読み込む用途では `Eagle Image Browser` の方が使いやすいです。

### Eagle Random Image

検索条件に合う画像から、`seed` に基づいて1枚を選びます。

同じ検索条件と同じ `seed` なら同じ画像を選びやすいため、再現性が必要なランダム選択に向いています。

