# 変更履歴 (History)

過去のバグ・修正の記録。新しいものを上に追記する。

## 2026-06-16: 家PC（高性能機）への移設をgit経由で実施

- **背景**: `SETUP_HANDOFF.md`はOneDrive同期での移設を想定していたが、実際にはgitリポジトリ化
  （`kurobuchicken-cell/auto_shortmovie-app`）して`C:\Users\kurob\dev\auto_shortmovie-app`に
  クローンする方式で移設された。OneDriveパス・`.env`の自動同期は発生しないため、APIキーと
  `input/input.mp4`は別途用意が必要だった。
- **Python未導入**: `python`/`py`コマンドはWindowsの「アプリ実行エイリアス」
  （Microsoft Storeへのスタブ）のみで、実体が入っていなかった
  （`python --version`が応答せず`py`は`command not found`）。
  `winget install --id Python.Python.3.13 -e` で実体をインストールして解決。
- **ffmpeg初回winget導入直後の未認識**: 既知の事象どおり、`npm run setup`実行中の同一シェルでは
  winget導入直後のffmpegがPATHに反映されず`FAIL`になった。新しいシェル（PATHを
  `Machine`+`User`から再取得）で再実行したところ`OK`になった。
- **GPU確認**: `nvidia-smi`でNVIDIA GeForce RTX 4060（Driver 546.17, CUDA 12.3）を確認。
- **GPU有効化（cuBLAS/cuDNN）**: `device="auto"`でモデル読み込み自体は成功するが、実際に
  `model.transcribe()`を呼んだ瞬間（エンコード時に初めてcuBLASが要求される）に
  `Library cublas64_12.dll is not found or cannot be loaded` で失敗した。
  - `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12`（`python/requirements.txt`に追記）で
    DLL自体は`site-packages\nvidia\*\bin`に入るが、Windowsはこの場所を自動でDLL検索しない。
  - `os.add_dll_directory()`（Python標準のDLL検索パス追加API）を試したが、ctranslate2の
    ネイティブ拡張は素のLoadLibrary呼び出しでDLLを探すため、これだけでは効かなかった
    （実際に`ctypes.WinDLL`で直接読めばadd_dll_directoryは効くのに、ctranslate2経由だと失敗する）。
  - **修正**: `python/transcribe.py`に`add_nvidia_dll_directories()`を追加し、
    `os.add_dll_directory()`に加えて該当ディレクトリを`os.environ["PATH"]`の先頭にも
    明示的に追加するようにした（PATHベースの検索は確実に効く）。`faster_whisper`を
    importする前に呼ぶ必要がある。
  - 修正後、GPUでの文字起こしが正常に動作し、1時間強の動画の全体文字起こし（`--mode claude`）
    が完走することを確認した。

## 2026-06-16: ハイライト検出をClaude APIベースに変更（--mode追加）

- **背景**: 音声ラウドネスのピーク検出は「うるさい＝面白い」を保証せず誤検出が多い
  （仕様書にも明記の既知の限界）。仕様書の「将来の拡張」で触れていたClaude API版の
  検出を、精度向上のため正式に実装することにした。
- **変更内容**:
  1. `python/transcribe.py` の出力JSONに `segments`（タイムスタンプ付き文節配列）を追加。
     既存の `text`/`srtPath` フィールドは変更なし（後方互換）。
  2. `src/python-utils.js` を新規作成し、`subtitles.js` にあったPython実行（spawn＋
     リアルタイムstderr転送＋タイムアウト）ロジックを共通化。
  3. `src/claude-detect.js` を新規作成。全体音声をWhisperで文字起こし→タイムスタンプ付き
     テキストをClaude API（`claude-sonnet-4-6`）に渡し、盛り上がり区間をJSONで受け取る。
  4. `src/deps-check.js` に `--mode claude` 時の `ANTHROPIC_API_KEY` 環境変数チェックを追加
     （未設定時は `--mode loudness` を使うよう案内する分かりやすいエラーで早期停止）。
  5. `src/config.js` に `--mode loudness|claude` フラグを追加。既定値は `claude`。
  6. `config.json` の `whisperModel` を `tiny`（前回の動作確認用の暫定値）から `medium` に戻した。
  7. `src/manifest.js` に `reason`（claudeモードの選定理由）フィールドを追加。
     `loudnessScore`/`reason` はどちらか一方がモードに応じて入り、他方は `null`。
- **既存のラウドネス検出（`src/loudness.js`）は変更せず保持**。`--mode loudness` で
  従来通り動作することを合成テスト動画で回帰確認済み。
- **注意**: このモードはClaude APIを呼ぶため、仕様書記載の「完全無料」という前提から外れ、
  実行ごとに少額（数円規模）のAPI課金が発生する。
- **見つけた不具合（修正済み）**: `src/claude-detect.js` の `clampAndValidate()` で、
  Claudeが返した `startSec` が音声長を超える場合、クランプ後に `startSec > endSec` の
  不正な区間が生成される可能性があった。対象を音声長以下の `startSec` のみに絞り、
  クランプ後も実質的な長さ（1秒未満）がない区間は除外するよう修正した。

## 2026-06-16: Whisperモデルダウンロード中に無音で止まって見える問題への対応

- **症状**: faster-whisperが初回実行時にHugging Faceからモデルをダウンロードする際、
  進捗が一切表示されず、処理が固まっているように見える（実際は通信中）。
- **原因**: `src/subtitles.js`が`child_process.execFile`でPythonを呼んでおり、
  子プロセスの標準出力・標準エラーは**プロセス終了後に一括取得**される仕様だったため、
  huggingface_hubのダウンロード進捗バー（tqdm、stderr出力）がリアルタイムに見えなかった。
- **修正**:
  1. `execFile`を`spawn`に変更し、子プロセスの`stderr`を`process.stderr`へリアルタイムに
     流すようにした（ダウンロード進捗・`[transcribe]`ログがその場で見える）。
  2. `config.json`の`whisperModel`を`medium`から`tiny`に変更（動作確認・速度優先。
     **確認が取れたら medium に戻す予定**）。
  3. 文字起こしに60秒のタイムアウトを追加（`config.json`の`whisperTimeoutSec`、
     `--timeout`フラグで上書き可）。タイムアウト時はそのクリップをスキップし、
     エラーメッセージを出して次のクリップの処理を続行する（既存の`runPool`の
     candidate単位エラーハンドリングにより、他の候補の処理は止まらない）。

## 2026-06-16: 初回実装

仕様書.html に基づき、Node.js + ffmpeg + faster-whisper のパイプラインを実装。
合成テスト動画（ffmpeg testsrc + sine波で生成）でエンドツーエンド検証し、以下のバグを発見・修正した。

### バグ1: ラウドネスのログ行が出力されない
- **症状**: 音声ピーク検出が常に「候補0件」になる。
- **原因**: `ebur128` フィルタの `framelog` パラメータは、動画出力がない場合に既定で `verbose` になる。ffmpegの既定ログレベルは `info` のため、`t:`/`M:` の行が出力されず `src/loudness.js` の正規表現が何もマッチしなかった。
- **修正**: `ebur128=metadata=1:framelog=info` を明示的に指定（`src/loudness.js`）。

### バグ2: ログ行の正規表現が不一致
- **症状**: バグ1修正後もまだ「候補0件」。
- **原因**: 実際のログ行は `t: 0.39 TARGET:-23 LUFS M: -12.2 ...` のように `t:` と `M:` の間に `TARGET:-23 LUFS` が挟まる。正規表現 `t:\s*(...)\s+M:\s*(...)` は直後に `M:` が来ることを前提にしていたため不一致だった。
- **修正**: 正規表現を `t:\s*(...).*?M:\s*(...)` に緩和（`src/loudness.js`）。

### バグ3: ウィンドウ統合後にクリップ長上限を超える／無音クリップで字幕焼き込みが落ちる
- **症状1**: ピーク同士が近接していると、重複ウィンドウの統合（仕様書通りの動作）でクリップ長が設定上限（既定30秒）を大幅に超えてしまう（テストで89秒になった）。
- **修正1**: 統合後に `clipMaxSec` でクランプする `clampWindowLength()` を追加（`src/loudness.js`）。
- **症状2**: 音声にセリフが検出されない（SEのみ等）クリップで faster-whisper が0個のセグメントを返し、空の `.srt` ファイルが生成される。これを ffmpeg の `subtitles` フィルタに渡すと `Unable to open ...` エラーで該当候補の処理全体が失敗する。
- **修正2**: `src/burn.js` で `.srt` が空（0バイト）の場合は字幕焼き込みをスキップし、縦化済み動画をそのまま `candidates/` にコピーするフォールバックを追加。

### 環境メモ
- このPCには ffmpeg が未導入だったため `winget install --id Gyan.FFmpeg` でインストール（`npm run setup` が自動実行）。
- whisper.cpp はWindowsビルドを避け、仕様書の代替案である `faster-whisper`（pip）を採用。
- 日本語フォントは追加インストール不要（Windows標準の Yu Gothic を使用）。
