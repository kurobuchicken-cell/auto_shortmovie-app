# auto_shortmovie-app

長尺ゲームプレイ動画（例：オバクック2人プレイ）から、ショート動画候補を半自動生成するローカルツール。
人間がやることは「出てきた候補を見て1本選ぶ」だけ。詳細仕様は `仕様書.html` を参照。

Local batch tool that turns a long gameplay video into several short-form
vertical video candidates with burned-in Japanese subtitles. A human only
needs to review and pick one. See `仕様書.html` for the full spec (Japanese).

## 初回セットアップ (one-time setup)

```
npm run setup
```

これは以下を行います:
- ffmpeg の確認・インストール（winget経由）
- Python / faster-whisper の確認・インストール（`pip install -r python/requirements.txt`）
- 日本語フォントの確認（Windowsの場合、通常 Yu Gothic / Meiryo が標準搭載）
- `input/` `work/` `candidates/` フォルダの作成

ffmpeg を winget でインストールした直後は、現在のターミナルに反映されないことがあります。
その場合は新しいターミナルを開いて `npm run setup` を再実行してください。

## 使い方 (usage)

1. 処理したい動画を `input/input.mp4` として置く（別名にしたい場合は `--input` で指定）
2. （既定の`--mode claude`を使う場合）プロジェクト直下に `.env` ファイルを作り、以下の1行を書く
   （`.env`は`.gitignore`済みで、OneDrive経由で他PCにも同期される。値は自分で入力すること）:
   ```
   ANTHROPIC_API_KEY=sk-ant-ここに実際のキー
   ```
3. 実行:

```
npm run clips
```

4. `candidates/clip_01.mp4 ... clip_0N.mp4` と `candidates/manifest.json` が生成される
5. `manifest.json` を見て、短い候補を見比べて1本選ぶ（以降は手動投稿）

### ハイライト検出モード (--mode)

| モード | 内容 | 必要なもの |
|---|---|---|
| `claude`（既定） | 全体を文字起こしし、Claude API（`claude-sonnet-4-6`）に渡して「掛け合い・笑い・盛り上がり」区間を選んでもらう。精度優先 | `.env`の`ANTHROPIC_API_KEY`（API利用料が少額発生する） |
| `loudness` | 音声の音量ピークから候補を検出する従来方式。完全無料・APIキー不要だが「うるさい＝面白い」と誤検出することがある | なし |

```
npm run clips -- --mode loudness
```

### オプション (CLI flags)

```
npm run clips -- --input input/other.mp4 --n 6 --model small --min 15 --max 30 --mode loudness
```

| flag | 対応する config | 既定値 |
|---|---|---|
| `--input` | inputPath | input/input.mp4 |
| `--mode` | detectionMode | claude（`loudness`も指定可） |
| `--n` | candidateCount | 8 |
| `--min` | clipMinSec | 25 |
| `--max` | clipMaxSec | 50 |
| `--model` | whisperModel | medium |
| `--width` | outputWidth | 1080 |
| `--height` | outputHeight | 1920 |
| `--timeout` | whisperTimeoutSec | 60 |

既定値は `config.json` で変更可能。

文字起こしが `--timeout` 秒を超えると、そのクリップはスキップされ次のクリップに進む
（タイムアウト時もモデルのダウンロード進捗等はターミナルにリアルタイム表示される）。
`--mode claude` では、クリップ切り出し前に動画全体の文字起こしも行うため、こちらは
`fullTranscribeTimeoutSec`（既定1800秒）が別途適用される。

## 手動クリップ指定 (manual clip)

`npm run clips` を実行した後にできる `work/full_transcript.srt`（全体の文字起こし）から、
自分で見つけた面白い区間をコピーしてセリフを訂正し、ファイルに保存して以下を実行すると、
その区間だけクリップ化して `candidates/manifest.json` に追記できる（既存候補は上書きしない）。

```
npm run manual-clip <貼り付けたテキストのファイルパス>
```

- 複数区間をまとめて指定する場合は、ブロックの間に `===` の行を入れる
- 訂正したセリフはそのまま字幕として使われる（再文字起こしはしない）
- `reason`（選定理由）は訂正済みのテキストを根拠にClaude APIで生成される

詳細は `仕様書.html` の「8. 手動クリップ指定機能」を参照。

## 字幕の一部をカラオケ風（文字単位タイミング）にする

字幕は既定では1文ずつまとめて表示される。「ちょちょちょちょ」のような早口の反復区間など、
特定の場面だけ1文字ずつ実際の発話タイミングに合わせて表示したい場合に使う。

**モードA：範囲指定**（自動で文字数に応じて均等割り、手軽だがタイミングは粗い）

```
npm run karaoke -- <candidate番号> <開始秒-終了秒> [<開始秒-終了秒> ...]
例: npm run karaoke -- 3 12.5-14.0 20.0-21.2
```

**モードB：タイミングファイル指定**（文字ごとに出現時刻を厳密指定、0.1秒単位推奨）

```
npm run karaoke -- <candidate番号> <タイミングファイルパス>
```

ファイル形式（1行＝「時刻 文字」、最後の行は時刻のみ＝表示終了タイミング）:
```
12.3 あ
12.5 い
12.8 う
13.0 え
13.4 お
13.8
```

- 秒数は `candidates/clip_NN.mp4` を再生した際のクリップ内ローカル時間
- 指定区間と重なる文だけがカラオケ表示になり、それ以外は一文ずつ表示のまま
- 複数区間を指定する場合は、ブロックの間に `===` の行を入れる（タイミングファイルのみ）
- 対象クリップは先に `npm run clips`（または `manual-clip`）で生成済みである必要がある
- モードAは実行ごとにクリップ全体を再生成、モードBは既存SRTの指定範囲だけを差し替える（高速）

詳細は `仕様書.html` の「9. 字幕の文字単位タイミング表示」を参照。

## トラブルシューティング (troubleshooting)

- **「ffmpeg が見つかりません」**: `npm run setup` を実行。インストール後に反映されない場合はターミナルを再起動。
- **「faster-whisper が見つかりません」**: `pip install -r python/requirements.txt` を手動実行。
- **「入力ファイルが見つかりません」**: `input/input.mp4` を配置するか `--input` で正しいパスを指定。
- **字幕が崩れる/誤変換が多い**: ゲームSEが混じった音声では誤変換が出ることがあります（仕様上の既知の限界）。字幕が綺麗な候補を選ぶか、採用した1本だけ手直ししてください。
- **字幕が韓国語など別言語の文字になる/全く関係ない内容になる**: クリップ単体の再文字起こしが無音区間でハルシネーション（存在しない発言の創作）を起こした可能性があります。VADフィルタで軽減していますが完全には防げません。`work/full_transcript.srt`（動画全体の文字起こしは文脈があり精度が高い）で同じ時間帯を確認し、`manual-clip`やカラオケのタイミングファイル指定で訂正してください。詳細は `仕様書.html` の「10. クリップ単体文字起こしのハルシネーション対策」を参照。
- **whisper モデルが重い/遅い**: `--model small` に変更（速度優先・精度低下）。`--model large` は精度優先・低速。
- **初回の文字起こしが遅い/モデルダウンロードが走る**: faster-whisper はモデルを初回実行時に Hugging Face から自動ダウンロードしてキャッシュします。最初の1回だけ時間がかかります。
- **「ANTHROPIC_API_KEY が環境変数に設定されていません」**: `--mode claude`（既定）を使うには `.env` ファイルに `ANTHROPIC_API_KEY=sk-ant-...` を書いておく必要がある（プロジェクト直下、`npm run clips`実行時に自動で読み込まれる）。設定が面倒な場合や課金を避けたい場合は `--mode loudness` を使う。

## 設計思想

このツールは全自動投稿ツールではない。機械が「探す・切る・縦化・字幕」を全部やり、
人間に残すのは「どれが良いか選ぶ」判断だけ。音声ピーク検出は「面白い」を保証しないため
（うるさい瞬間も拾う）、候補を多めに出して人間が選ぶ設計になっている。
