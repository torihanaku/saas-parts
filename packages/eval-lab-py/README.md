# @torihanaku/eval-lab-py

## 用途

AI（LLM）を使った検索・マッチング系機能の**品質を人手＋LLM-as-judge で回帰評価するためのローカル実験ラボ**です。Python + FastAPI + SQLite（WAL）で単一ファイル起動でき、ブラウザ UI から「クエリ集を投げる → 対象 API の返答を集める → 別の LLM が採点する → 実験結果を DB に保存して過去実験と比較する」という一連のループを回せます。

コンパイル対象の TypeScript コードではなく、**新規プロジェクトの `tools/` などにコピーしてそのまま `python` で動かすテンプレート**を `templates/eval-lab/` 以下に元リポと同じ相対構造で収録しています（`src/` を持たないため saas-parts の tsc / vitest の対象外）。

出典: `dev-dashboard-v2/tools/eval-lab/`（約 2,200 行）。元コードは「AIキャラクターマッチング API」の評価を題材にしていますが、**評価対象 API のエンドポイント・入出力の解釈部分を差し替えれば、任意の検索/マッチング/RAG/分類系 API の評価に転用できます**。

## 収録ファイル一覧

```
templates/eval-lab/
├── app.py            # FastAPI 実験ラボ本体（UI + 評価ランナー + SQLite 永続化）
├── auto-tune.py      # クエリのクラスタリング＋パラメータ自動チューニング支援
├── gap-detector.py   # 評価結果から「不足している対象タイプ」を検出（任意で LLM 提案）
├── requirements.txt  # fastapi / uvicorn / aiohttp / python-multipart のみ
└── MANUAL.md         # 使い方マニュアル（日本語）
```

- `app.py` — ブラウザ UI（Tailwind CDN 埋め込み）から評価対象 API・Judge モデル（Gemini / OpenAI を選択）・並列度を指定して一括評価。結果は SQLite に実験単位で保存し、過去実験とスコア差分を比較できます。Judge 用プロンプトは冒頭の `JUDGE_PROMPT` にあり、評価軸を自プロダクトに合わせて書き換えます。
- `auto-tune.py` — 評価に使うクエリ集を日本語トークンの重なりでクラスタリングし、代表クエリの抽出やパラメータ探索を補助します。
- `gap-detector.py` — 評価ログを集計し「どの入力パターンで精度が低いか＝カバレッジの穴」を洗い出します。`GEMINI_API_KEY` があれば不足タイプを LLM に提案させられます（未設定ならこの機能だけスキップ）。

## 起動方法

```bash
cd templates/eval-lab
pip install -r requirements.txt

# Judge に LLM を使う場合のみ（UI のフォームからも入力可）
export GEMINI_API_KEY=your_key_here      # Gemini を Judge にする場合
export OPENAI_API_KEY=your_key_here      # OpenAI を Judge にする場合

python app.py
# → http://localhost:8100 をブラウザで開く
```

評価対象 API の URL は UI 上のフォーム（既定値 `http://localhost:3000`）で指定します。詳細は `MANUAL.md` を参照してください。

## 自プロダクトへの適用手順

1. `templates/eval-lab/` をコピー
2. `app.py` の評価対象 API 呼び出し部（リクエスト整形・レスポンス解釈）を自 API の入出力に合わせて修正
3. `JUDGE_PROMPT`（app.py 冒頭）の評価軸・観点を自プロダクトのドメインに書き換え
4. `character` / `キャラクター` という語は元題材（マッチング対象）の呼称。自プロダクトの評価対象名に一括置換
5. クエリ集（評価用の入力例）を用意して UI から投入

## `@torihanaku/eval-harness` との関係

- **本パッケージ（eval-lab-py）** = Python 製の**対話的な実験ラボ**。人が UI で試行錯誤しながらプロンプト・パラメータを詰める「探索フェーズ」向け。SQLite に実験履歴を貯め、過去との比較や auto-tune / gap-detect といった分析まで一体で提供します。単体で動く独立ツールです。
- **`@torihanaku/eval-harness`** = TypeScript 製の**評価ハーネス（ライブラリ）**。CI / テストコードから呼び出してスコアを機械的にゲートする「定着・自動化フェーズ」向け。

使い分けの目安: ラボ（本パッケージ）で評価軸と合格ラインを固めたら、その基準を eval-harness 側の自動評価に落として CI で回帰を止める、という二段構えを想定しています。両者は依存関係を持たず、役割で補完し合います。

## 除外・注意

- 元ディレクトリの `experiments.db-shm` / `experiments.db-wal`（SQLite の実行時一時ファイル）と `__pycache__` は転用価値がないため収録していません。DB は初回起動時に自動生成されます。
- API キーはコードに直書きせず、環境変数または UI フォームからのみ受け取ります（元コードにハードコードされた秘密情報・プロジェクト ID は含まれていないことを確認済み）。

## 依存 / 想定ランタイム

Python 3.10+ / `requirements.txt`（fastapi, uvicorn, aiohttp, python-multipart）。TypeScript ビルドには一切関与しません。
