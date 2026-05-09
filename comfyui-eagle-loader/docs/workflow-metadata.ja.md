# 埋め込み workflow と metadata を扱う

ComfyUI で保存された PNG などには、workflow や prompt 情報が埋め込まれていることがあります。

このカスタムノードでは、Eagle に登録された画像からその情報を読み出せます。

## ギャラリーから読み込む

通常は `Eagle Image Browser` のギャラリーで画像を選び、`Load WF` を押すのが一番簡単です。

この操作は、選択した Eagle item の元画像を読み、埋め込まれた ComfyUI workflow を現在の ComfyUI に読み込みます。

## Eagle Extract Embedded Workflow

workflow 情報を JSON として取り出したい場合に使うノードです。

入力:

- `item_id`: Eagle item ID。
- `metadata_json`: `Eagle Image Browser` などから出た metadata。

出力:

- `workflow_json`: ComfyUI workflow。
- `prompt_json`: prompt 情報。
- `keys_json`: 画像に含まれていた metadata key の一覧。

## metadata_json と item_id の使い分け

基本的には `metadata_json` をつなぐのがおすすめです。  
`metadata_json` には item ID や file path など、読み込みに使える情報が含まれています。

item ID だけが分かっている場合は `item_id` を直接指定できます。

## workflow が見つからない場合

すべての画像に workflow が入っているわけではありません。

次の点を確認してください。

- 対象画像が ComfyUI から保存された画像か。
- サムネイルではなく元画像を対象にしているか。
- Eagle に登録した時点で metadata が消えていないか。

