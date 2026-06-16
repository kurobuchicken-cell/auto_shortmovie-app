# 引き継ぎメモ：別PC（高性能機）への移設

このファイルは、ノートPCで構築した `auto_shortmovie-app` を、家の高性能PCに
移設するための引き継ぎ用メモ。**新しいPCのClaude Codeセッションで、まずこのファイルを
読んでから作業を進めてもらう。**

## 背景・経緯

- ノートPC（`C:\Users\kin\OneDrive\ドキュメント\auto_shortmovie-app`）で実装・セットアップ済み。
- 動画処理（特にffmpegのエンコード・whisperの文字起こし）が重く、処理時間がかかるため、
  家の高性能PCで動かしたい。
- 詳しい仕様は `仕様書.html`、使い方は `README.md`、過去のバグ修正履歴は `HISTORY.md` を参照。

## このプロジェクトについて（要約）

- 長尺ゲームプレイ動画から、縦動画・字幕付きのショート候補を自動生成するNode.js CLIツール。
- ハイライト検出は2方式（`--mode`で切り替え。詳細は後述）:
  - `claude`（既定）: Claude APIで盛り上がり区間を判定。精度優先だが少額のAPI課金が発生する
  - `loudness`: 音声ラウドネスのピーク検出。完全無料・ローカルのみだが誤検出が出やすい
- 主要技術: Node.js（オーケストレーション）、ffmpeg（カット・縦化・字幕焼き込み・音声解析）、
  faster-whisper（Pythonの文字起こしエンジン。whisper.cppのWindowsビルドが大変なため代替採用）、
  Claude API（`claude-sonnet-4-6`、`--mode claude`時のみ使用）。
- git管理はしていない（gitリポジトリではない）。OneDriveの`ドキュメント`フォルダ配下にあるため、
  **同じOneDriveアカウントなら、家のPCにもこのフォルダが自動的に同期されている可能性が高い。**
  まずOneDriveの同期状況を確認すること（フォルダが既にあれば手動コピーは不要）。
  - `input/input.mp4`に実際の動画（約3.4GB、ノートPCで配置済み）が入っている。OneDriveの
    アップロード/同期には時間がかかるので、**家のPCで作業を始める前にOneDriveの同期が
    完了しているか確認すること**（同期中はファイルが不完全な場合がある）。
- このプロジェクト専用のルールは `CLAUDE.md` に記載（ユーザーファイルがあるディレクトリを
  一括削除しない、`input/`に自分のテスト用ファイルを書き込まない、等）。**必ず一読すること。**

## 家PCでやること（順番に）

### 1. プロジェクトフォルダの有無を確認

OneDriveが同期済みなら、家のPCにも以下のパスが既に存在するはず:
```
C:\Users\<ユーザー名>\OneDrive\ドキュメント\auto_shortmovie-app
```
存在しない場合は、ノートPCから手動でフォルダ全体をコピーする
（`node_modules`は存在しない＝npm依存ゼロなので、コピーするのはこのフォルダの中身そのまま全部でよい。
`work/`と`candidates/`の中身は中間生成物なので無くても問題ないが、`.gitkeep`は残すこと）。

### 2. 事前確認（家のPCは2年前のゲーミングPC想定。ノートPCには無かった準備が必要な場合あり）

- **Pythonが入っているか確認**: `python --version`。ノートPCには既にPython 3.14が入っていたが、
  ゲーミングPCは未確認。無ければ [python.org](https://www.python.org/) または
  `winget install Python.Python.3.13` 等で先にインストールする（`npm run setup`はPython自体は
  インストールしない、存在確認とpipインストールのみ行う）。
- **wingetが使えるか確認**: `winget --version`。2年前のWindowsだと`winget`（App Installer）が
  古く`winget install`が失敗することがある。失敗する場合はMicrosoft Storeで
  「App Installer」を更新してから再試行する。
- **GPU（NVIDIA）の認識を確認**: `nvidia-smi` を実行し、GPU名とドライババージョンが表示されるか
  確認する。表示されない場合はGPUドライバの更新が必要（faster-whisperはGPUが無くても動くが、
  CPUのみだと文字起こしが遅い）。

### 3. 環境セットアップを実行

ターミナル（PowerShellなど。Claude Code上ではなく通常のターミナル）で:
```
cd "C:\Users\<ユーザー名>\OneDrive\ドキュメント\auto_shortmovie-app"
npm run setup
```

これで以下を自動チェック・インストールする:
- ffmpeg（未インストールなら `winget install --id Gyan.FFmpeg` で導入）
- Python + faster-whisper（`pip install -r python/requirements.txt`）
- 日本語フォント確認（Windows標準のYu Gothic等があればOK、なければ警告のみ）
- `input/` `work/` `candidates/` フォルダ作成

### 3-1. GPU加速の有効化（移設の主目的）

`npm run setup`は今のところCPU/GPU共通のpip依存（`faster-whisper`）しか入れない。GPU（CUDA）を
実際に使わせるには追加確認が必要な場合がある:

- `python -c "import torch" 2>&1` 等は不要（torch非依存）。まず何もせず`npm run clips`を実行し、
  `[transcribe] loading model=...`のログの後の処理速度で、GPUが使われているか体感確認する
  （1時間動画の全体文字起こしがCPUのみだと非常に遅い場合、GPUが使われていない可能性）。
- `ctranslate2`（faster-whisperの内部エンジン）はGPU使用に**cuBLAS/cuDNNランタイム**を必要とする。
  フルのCUDA Toolkitを別途インストールしなくても、多くの場合
  `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12` で足りる（要検証。バージョン不一致で
  失敗する場合は`pip show ctranslate2`で対応CUDAバージョンを確認する）。
- **このパッケージ追加は`python/requirements.txt`の変更を伴うので、実行前にユーザーへ確認を取ること**
  （`CLAUDE.md`の「新しいパッケージ・依存ライブラリを追加する前に確認を取る」ルールに従う）。
- GPUが認識されない／高速化されない場合でも、CPUのみで動作はする（遅いだけ）。動作自体は
  ブロッカーにならないので、まず動かしてから最適化を検討すればよい。

### 4. 既知の注意点（ノートPCで実際に発生したもの）

- **ffmpegをwingetでインストールした直後は、同じターミナルのPATHに反映されないことがある。**
  `npm run setup`実行後に `ffmpeg: FAIL` と出たら、ターミナルを閉じて新しく開き、
  もう一度 `npm run setup` を実行する（インストール自体は完了しているので2回目はOKになるはず）。
- faster-whisperのモデル（`config.json`の`whisperModel`、既定は`medium`）は**初回実行時に
  Hugging Faceから自動ダウンロード**される。初回だけ時間とネット接続が必要。
- `python/transcribe.py`は`device="auto", compute_type="auto"`でモデルを読み込んでいる。
  **高性能PCにNVIDIA GPUがあれば、faster-whisper（ctranslate2）が自動的にCUDAを使い、
  文字起こしが大幅に高速化される可能性が高い**（これが移設の主目的のはず）。GPU認識が
  うまくいかない場合は `pip show ctranslate2` やCUDA/cuDNNのインストール状況を確認すること。

### 5. Claude APIモード（既定）を使う場合: APIキーの設定

`--mode claude`（既定）を使うには `ANTHROPIC_API_KEY` が必要。**`.env`ファイル方式**を採用している
（`package.json`の`clips`スクリプトが`node --env-file-if-exists=.env`で起動するため、
プロジェクト直下に`.env`があれば自動的に読み込まれる。無ければ単に無視される）。

- ノートPC側で`.env`ファイルをプロジェクト直下に作成済み（中身: `ANTHROPIC_API_KEY=sk-ant-...`）。
  **`.env`は`.gitignore`対象だが、OneDrive同期の対象には入っている**ので、OneDriveの同期が
  完了していれば家のPCにも自動的にこのファイルが来ているはず。まずそれを確認すること。
- 来ていない場合は、家のPCで`.env`を新規作成し、同じ値（または新規発行したキー）を1行で書く:
  ```
  ANTHROPIC_API_KEY=sk-ant-ここに実際のキー
  ```
- 旧方式（`setx`によるOS環境変数）は廃止した。理由: PCごとに再設定が必要で面倒だったため、
  OneDrive同期で引き継がれる`.env`方式に変更した（トレードオフとして、APIキーがOneDrive上にも
  平文で保存されることになるが、ユーザー判断で許容している）。
- APIキー無しで動かしたい場合は `npm run clips -- --mode loudness` で代替できる
  （無料・ローカルのみ、誤検出は出やすい）。

### 6. 動作確認

```
npm run clips
```
（`input/input.mp4`が無い場合は「入力ファイルが見つかりません」と出るのが正常。
実際の動画を`input/input.mp4`に置いてから再実行する。ノートPCで配置した動画が
OneDrive同期済みならそのまま使えるはず。）

`--mode claude`は切り出し前に動画**全体**の文字起こしを行うため、1時間動画だと
それなりに時間がかかる（`config.json`の`fullTranscribeTimeoutSec`、既定1800秒）。
高性能PCならここが速くなることが期待値。

詳しい使い方・オプション一覧は `README.md` を参照。

## 新セッションのClaude Codeへの依頼事項

1. まず本ファイル・`CLAUDE.md`・`README.md`・`HISTORY.md`を読み、プロジェクトの全体像を把握する。
2. 上記「家PCでやること」の手順を順に実行する（`npm run setup`の実行、`ANTHROPIC_API_KEY`の
   設定、結果確認）。
3. もし新たな不具合（GPU認識しない、別PATH問題、OSバージョン差異など）が見つかったら、
   `HISTORY.md`に追記する（日付・症状・原因・修正の形式で、既存エントリを参考に）。
4. **`input/input.mp4`には絶対に自分のテスト用ファイルを書き込まない・上書きしない・
   削除しない**（`CLAUDE.md`参照。既にこの事象でユーザーの実ファイルを2度危険にさらした
   実績があるため、特に厳重に守ること）。動作確認で合成動画が必要な場合は
   `work/_test_fixtures/`等、`input/`以外の場所に作る。
5. セットアップが完了したら、ユーザーに「準備完了。input/input.mp4（OneDrive同期済みなら
   既にあるはず）を確認し、npm run clipsを実行してください」と伝える。
