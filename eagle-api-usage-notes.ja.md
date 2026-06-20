# Eagle API 利用時の注意点

[English version](eagle-api-usage-notes.md)

このページでは、Eagle-ComfyUI Integration の開発・運用中に確認された Eagle API 周りの注意点をまとめています。

通常の利用では意識する必要はありませんが、以下のような場合に役立ちます。

- 動作がおかしいときに原因を切り分けたい
- Eagle plugin 側を改修したい
- ComfyUI 側のノードを拡張したい
- Eagle API を使った別の連携機能を作りたい

Eagle の API は便利ですが、Eagle のバージョンや実行環境によって返却データや利用できる関数に差が出ることがあります。  
このプロジェクトでは、それらの差をできるだけ吸収するために Bridge 側で正規化や検証を行っています。

---

## 早見表

各項目の要点だけを先に確認できる一覧です。詳細は下の各セクションを参照してください。

| #  | テーマ | 結論（要点） |
|----|--------|------------|
| 1  | item の path 検証 | `filePath` / `thumbnailPath` は item ID と照合してから使う |
| 2  | item 読み取りの直列化 | 画像 path を使う処理では並列化しすぎない |
| 3  | `thumbnailPath` の扱い | 検証・再取得前提。キャッシュキーに item ID を含める |
| 4  | `folder.getAll()` の揺れ | 返却形式（配列 / ツリー / フィールド名）を Bridge で正規化 |
| 5  | フォルダ指定 | フォルダ名より ID を優先する |
| 6  | item フィールドの欠損 | `.get()` などで防御的に取得する |
| 7  | Live updates | 関数の存在チェックをし、無ければ無効化する |
| 8  | `onLibraryChanged` | path が実際に変わった時だけ通知する |
| 9  | ライブラリ切り替え | API では行わず Eagle UI 前提にする |
| 10 | 画像追加 | ローカル構成では `addFromPath` を優先する |
| 11 | timeout | API 呼び出しには必ず付ける |
| 12 | 日本語ファイル名 | HTTP header に直接入れず UTF-8 エンコードする |
| 13 | `nativeImage` | 使えない環境ではリサイズしない |
| 14 | Bridge での正規化 | 生データに依存せず正規化してから返す |
| 15 | 拡張時の方針 | ID 照合・ID 優先・欠損対応・timeout を徹底する |

---

## 1. item の `filePath` / `thumbnailPath` は検証してから使う

**結論：`filePath` / `thumbnailPath` は必ず `item.id` と照合してから使い、別 item を指していたら再取得する。それでも直らなければ画像を返さない。**

Eagle の item には、元画像やサムネイルの場所として次のような値が含まれます。

- `filePath`
- `thumbnailPath`

通常はその item 自身の `.info` フォルダ内を指します。

例:

```text
.../images/ITEM_ID.info/image.png
.../images/ITEM_ID.info/image_thumbnail.png
```

しかし、環境やタイミングによっては、要求した item ID とは別の item の path が返ることがあります。

例えば:

```text
要求した item id: A
返ってきた thumbnailPath: .../B.info/image_thumbnail.png
```

この状態でそのまま画像を表示すると、別 item のサムネイルや画像が表示されてしまいます。

そのため、このプロジェクトでは以下を確認しています。

- `item.id` が要求した ID と一致しているか
- `filePath` がその item の `.info` フォルダ配下か
- `thumbnailPath` がその item の `.info` フォルダ配下か

不一致があった場合は再取得し、それでも直らない場合は誤った画像を返さないようにしています。

---

## 2. item 読み取りは並列化しすぎない

**結論：画像 path を使う処理では item 読み取りを直列化し、返ってきた path を必ず検証する。**

大量のサムネイルを表示する場合、複数の item を同時に取得したくなります。

しかし、Eagle Plugin API の item 読み取りを高並列で行うと、環境によっては item の一部情報が混ざったように見えるケースがありました。

例:

```text
item.id は正しい
しかし filePath / thumbnailPath が別 item のものになっている
```

このため、画像 path を扱う重要な処理では、Bridge 側で item 読み取りを直列化しています。

対象例:

- サムネイル取得
- 元画像取得
- workflow metadata 抽出
- `Load WF`
- ComfyUI ノード実行時の画像取得

並列処理を完全に避ける必要はありませんが、少なくとも画像 path を使う処理では検証が必要です。

---

## 3. `thumbnailPath` は便利だが、信用しすぎない

**結論：`thumbnailPath` は検証・再取得前提で扱い、キャッシュキーには item ID と path を含める。**

`thumbnailPath` は軽量なプレビュー表示に便利です。

ただし、前述の通り別 item を指す可能性があるため、このプロジェクトでは次のように扱っています。

1. `thumbnailPath` を取得する
2. path が現在の item ID の `.info` フォルダ配下か確認する
3. 問題があれば再取得する
4. それでも不正なら誤画像を返さない

サムネイル表示の高速化のためにキャッシュを使う場合も、item ID や path を含めた衝突しにくいキーを使う必要があります。

---

## 4. `folder.getAll()` の返却形式には揺れがある

**結論：返却形式（配列 / ツリー / フィールド名）に揺れがあるので、Bridge 側で正規化して扱う。**

Eagle のフォルダ一覧取得では、環境によって返却形式が異なる場合があります。

例えば、単純な配列として返る場合もあれば、ツリー構造として返る場合もあります。

```js
[
  { id: "...", name: "Parent" }
]
```

または:

```js
[
  {
    id: "...",
    name: "Parent",
    children: [
      {
        id: "...",
        name: "Child"
      }
    ]
  }
]
```

さらに、環境によっては以下のような別名が使われる可能性もあります。

### ID の候補

- `id`
- `folderId`
- `folder_id`
- `uuid`
- `_id`

### 名前の候補

- `name`
- `folderName`
- `folder_name`
- `title`
- `label`

### 親フォルダの候補

- `parent`
- `parentId`
- `parent_id`
- `pid`

このプロジェクトでは Bridge 側でフォルダ情報を正規化し、子フォルダ・孫フォルダも含めて次のような path 形式に変換しています。

```text
Parent
Parent/Child
Parent/Child/Grandchild
```

これにより、ComfyUI 側では階層フォルダも通常の選択肢として扱えます。

---

## 5. フォルダ指定は ID を優先する

**結論：フォルダは名前ではなく ID で指定する（path 表示は UI 用と考える）。**

Eagle のフォルダは同じ名前を複数作れる場合があります。

そのため、内部処理ではフォルダ名よりもフォルダ ID を優先しています。

UI では分かりやすくするために、次のような表示にしています。

```text
Parent/Child [folderId]
```

ユーザーは path を見て選択できますが、実際の処理では ID を使います。

文字列 path 指定も対応していますが、確実性では ID 指定の方が安全です。

---

## 6. item のフィールドは必ず存在するとは限らない

**結論：item のフィールドは欠損しうるので、`.get()` などで防御的に取得する。**

Eagle の item には多くの情報があります。

例:

- `name`
- `tags`
- `star`
- `annotation`
- `folders`
- `width`
- `height`
- `filePath`
- `thumbnailPath`

ただし、API の種類や Eagle の状態によっては、一部のフィールドが存在しないことがあります。

そのため、このプロジェクトでは Python / JavaScript 側で次のような防御的な取得を行っています。

```python
item.get("star", 0)
item.get("tags", [])
item.get("annotation", "")
```

直接参照すると、存在しないキーでエラーになる場合があります。

```python
item["star"]  # star が無いとエラー
```

拡張や改修を行う場合も、item のフィールドは `.get()` などで安全に扱うことを推奨します。

---

## 7. Live updates は Eagle のバージョンに依存する

**結論：Live updates 用の関数は存在チェックし、無ければ無効化する（通常機能は維持される）。**

このプロジェクトでは、Eagle ライブラリの変更検知に Live updates を使う場合があります。

ただし、利用しようとした関数が Eagle のバージョンによって存在しないことがあります。

例:

```text
eagle.item.getIdsWithModifiedAt is not a function
```

そのため、Bridge 側では関数の存在を確認し、利用できない場合は Live updates を無効化します。

この場合も、通常の検索・表示・読み込みは利用できます。

---

## 8. `onLibraryChanged` は実際の切り替え以外でも発火する場合がある

**結論：`onLibraryChanged` は path が実際に変わった時だけ ComfyUI 側へ通知する。**

Eagle にはライブラリ切り替えを検知するイベントがあります。

ただし、初期接続時や同じライブラリを開いている状態でも通知が来る場合があります。

そのため、このプロジェクトでは以下のように処理しています。

- 初回通知は基準値として保存する
- 現在の library path と同じ通知は無視する
- 実際に path が変わった場合だけ ComfyUI 側に通知する

これにより、不要な `Library changed.` 表示を抑えています。

---

## 9. API から Eagle のライブラリ切り替えは基本的に行わない

**結論：ライブラリ切り替えは Eagle UI 前提とし、ComfyUI 側は検知して Refresh を促すだけにする。**

Eagle は複数のライブラリを持てます。

現在のライブラリ情報は取得できます。

例:

- library name
- library path
- library info

しかし、公式 API として次のような操作は確認できていません。

- ライブラリ一覧を取得する
- API からライブラリを切り替える
- API から指定ライブラリを開く

そのため、このプロジェクトではライブラリの切り替え自体は Eagle 側 UI で行う前提です。

ComfyUI 側では、ライブラリが切り替わったことを検知した場合に Refresh を促します。

---

## 10. 画像追加では `addFromPath` が安定しやすい

**結論：ローカル構成では `addFromPath` を優先し、`addFromURL` / `addFromBase64` は fallback として使う。**

ComfyUI で生成した画像を Eagle に追加する方法はいくつかあります。

### addFromPath

ComfyUI と Eagle が同じ PC 上で動いている場合に使います。

ComfyUI が保存したローカルファイル path を Eagle に渡します。

```text
Eagle と ComfyUI が同じ PC
  -> addFromPath
```

この方式が最も安定しやすいため、`Eagle Quick Send to Eagle` のデフォルトにしています。

---

### addFromURL

Eagle が ComfyUI の画像 URL にアクセスできる場合に使います。

```text
Eagle が ComfyUI の URL を読める
  -> addFromURL
```

リモート構成や別マシン構成で使うことがあります。

ただし、環境によっては処理が戻らないケースがあったため、ローカル構成では `addFromPath` を推奨します。

---

### addFromBase64

ComfyUI 側から画像データを Base64 として Eagle に送る方式です。

```text
URL で取りに行けない
  -> addFromBase64
```

リモート構成の fallback として利用できます。

ただし、大きな画像ではデータ量が増えやすく、環境によっては Eagle 側の処理が戻らないケースがありました。

---

## 11. Eagle API 呼び出しには timeout を付ける

**結論：返答が戻らない API があるため、呼び出しには必ず timeout を設ける。**

Eagle API の一部処理は、環境によって返答が戻らないことがあります。

確認された例:

- `addFromURL`
- `addFromBase64`

そのため、Bridge 側では API 呼び出しに timeout を設けています。

timeout が無い場合、Eagle plugin 側の処理が止まったように見えることがあります。

---

## 12. 日本語ファイル名を HTTP header にそのまま入れない

**結論：日本語ファイル名は header に直接入れず、ASCII fallback ＋ `filename*=UTF-8''` で渡す。**

Eagle では日本語のファイル名、タグ、フォルダ名を普通に扱います。

しかし、Node.js の HTTP header に日本語をそのまま入れるとエラーになる場合があります。

例:

```text
Invalid character in header content ["Content-Disposition"]
```

そのため、このプロジェクトでは `Content-Disposition` を返す際に以下のような形式を使います。

```http
Content-Disposition: inline; filename="fallback.png"; filename*=UTF-8''...
```

- `filename` には ASCII の fallback 名を入れる
- `filename*` に UTF-8 エンコードした名前を入れる

---

## 13. `nativeImage` が使えない環境がある

**結論：`nativeImage` が使えない環境ではリサイズせず、元のサムネイルをそのまま返す。**

Eagle は Electron ベースのアプリですが、plugin 実行環境で常に Electron の `nativeImage` が使えるとは限りません。

サムネイルのリサイズに `nativeImage` を使おうとした場合、環境によっては利用できません。

そのため、このプロジェクトでは `nativeImage` が使えない場合はリサイズを行わず、元のサムネイルをそのまま返します。

---

## 14. Bridge 側で正規化してから ComfyUI 側へ返す

**結論：Eagle の生データに直接依存せず、Bridge 側で正規化してから ComfyUI 側へ返す。**

Eagle API の返却データには揺れがあるため、ComfyUI 側で Eagle の生データに直接依存しすぎると不具合が起きやすくなります。

このプロジェクトでは、Bridge 側でなるべく次の処理を行います。

- item 情報の正規化
- folder 情報の正規化
- path の検証
- フォルダ階層の平坦化
- API 機能の存在チェック
- timeout
- エラー整形

ComfyUI 側は、Bridge から返ってきた比較的安定した形式を使う方針です。

---

## 15. 拡張時の推奨方針

**結論：item ID 照合・ID 優先・欠損フィールド対応・timeout を徹底すれば、拡張時も安定しやすい。**

Eagle API を使う新しい機能を追加する場合は、以下の方針を推奨します。

### item を扱う場合

- `item.id` を必ず確認する
- `filePath` / `thumbnailPath` は item ID と照合する
- 欠損フィールドに備える
- 必要に応じて読み取りを直列化する

### folder を扱う場合

- ID を優先する
- path 表示は UI 用と考える
- `children` を再帰展開する
- フィールド名の揺れに備える

### 画像追加を行う場合

- ローカル構成では `addFromPath` を優先する
- リモート構成では `addFromURL` を検討する
- fallback として `addFromBase64` を使う
- timeout を必ず設ける

### Live updates を使う場合

- 関数の存在チェックをする
- 非対応環境でも通常機能が使えるようにする

---

## まとめ

Eagle API は強力ですが、返却データや利用可能な関数に環境差が出ることがあります。

このプロジェクトでは、以下の考え方で安定性を高めています。

- Eagle API の結果をそのまま信じすぎない
- Bridge 側で正規化する
- path は item ID と照合する
- フォルダ階層は Bridge 側で平坦化する
- API 呼び出しには timeout を付ける
- ローカル画像追加は `addFromPath` を優先する

これらの対策により、ComfyUI 側ではできるだけ安定した形で Eagle の画像・タグ・フォルダ・メタデータを扱えるようにしています。
