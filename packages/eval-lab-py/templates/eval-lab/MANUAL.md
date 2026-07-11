# Eval Lab & Auto-Tune マニュアル

マッチングモデルを「実験 → 分析 → 改善 → 検証 → デプロイ」の順で回すための手順書です。

---

## ツール一覧

| ファイル | 役割 |
|---------|------|
| `app.py` | 実験ラボ本体。ブラウザで操作する。クエリを大量投入してAIが評価し、結果をDBに保存する |
| `auto-tune.py` | DBに溜まった結果からモデルを自動改善するスクリプト |
| `gap-detector.py` | 「うまくマッチしなかったクエリ」を分析して、不足しているキャラクタータイプを発見するスクリプト |

実験データはすべて `experiments.db`（SQLite）に保存されます。削除しない限りデータは消えません。

---

## セットアップ（初回のみ）

```bash
cd tools/eval-lab

# 依存ライブラリをインストール
pip install -r requirements.txt

# APIキーを設定（.env などで管理してもOK）
export GEMINI_API_KEY=your_key_here
export OPENAI_API_KEY=your_key_here   # OpenAIを使う場合

# サーバー起動
uvicorn app:app --reload --port 8765
```

ブラウザで `http://localhost:8765` を開くと実験ラボが表示されます。

---

## ステップ1: クエリを用意する

実際に想定されるユーザーの依頼文（タスク記述）を集めます。

例:
```
Meta広告のオーディエンスセグメント最適化をしたい
SaaS向けのコンテンツマーケティング戦略を立てたい
展示会リードのナーチャリングフローを設計したい
```

- ClaudeやGeminiで大量生成するのがおすすめです（100〜1000件）
- 1行1クエリのテキスト、またはCSVで用意します

---

## ステップ2: 実験を実行する（app.py）

1. ブラウザで `http://localhost:8765` を開く
2. 「New Experiment」タブを選ぶ
3. フォームに入力する
   - **実験名**: わかりやすい名前（例: `2026-04-01 Meta広告テスト`）
   - **APIエンドポイント**: マッチングAPIのURL（通常 `http://localhost:3000/api/character-templates/match`）
   - **Judge Model**: 評価に使うAIモデル（`gemini-2.0-flash` 推奨。無料枠あり）
   - **並列数**: 5〜10が安全。APIに負荷をかけたくない場合は3
   - **クエリ**: テキストエリアに貼り付けるか、CSVをアップロード
4. 「実験開始」ボタンを押す

処理は非同期なので、投入後はページを閉じても続きます。
結果は「History」タブでいつでも確認できます。

---

## ステップ3: 結果を確認する

実験が終わったら「History」タブで確認します。

- **nDCG@5**: 1.0 が満点。0.85以上なら良好。0.85未満は要改善
- **弱いクエリ数**: nDCG < 0.85 のクエリ一覧を見る
- **Analysisボタン**: どのキャラクターが間違ってTop1になっているか確認できる

fine-tuningデータのダウンロードは「Finetune Export」ボタンから。

---

## ステップ4: 自動チューニングを実行する（auto-tune.py）

実験結果をもとに、モデルのパラメーターとボキャブラリーを自動改善します。

```bash
# 全工程を一気に実行（推奨）
python auto-tune.py all

# 個別に実行する場合
python auto-tune.py report      # 現状分析レポートを生成（何も変えない）
python auto-tune.py vocab       # 不足ボキャブラリーを補充するデータを生成
python auto-tune.py proficiency # BM25パラメーター（k1/b）の最適値を計算
python auto-tune.py apply       # 上記の結果をTypeScriptのコードに書き込む（要注意）
```

`apply` コマンドは実際にコードを書き換えます。実行前に `git status` で変更を確認してください。

生成されるファイル:
- `auto-tune-report.md` — 分析レポート（何が問題で、何を変えたか）
- `vocab-supplement.json` — ボキャブラリー補充データ

---

## ステップ5: ギャップ分析をする（gap-detector.py）

「そもそもDBにマッチするキャラクターが存在しない」パターンを検出します。

```bash
# 最新の実験ラン結果を分析
python gap-detector.py report

# Gemini APIで不足キャラクタータイプを提案させる
python gap-detector.py suggest

# 全ランを合算して分析
python gap-detector.py report --all-runs
```

生成されるファイル（`gap-reports/` フォルダ内）:
- `gap-report-YYYYMMDD-HHMMSS.md` — レポート
- `new-character-suggestions.json` — Geminiが提案した追加すべきキャラクタータイプ

提案されたキャラクタータイプは、スキルシステムプレイブック（`docs/skill-system-playbook.md`）の手順でDBに追加できます。

---

## ステップ6: 検証する

改善後に再度実験を実行して、スコアが上がったか確認します。

```bash
# TypeScriptの評価スクリプトでも確認できる
bun run server/scripts/persona-eval.ts

# 特定クエリで手動テスト
curl -X POST http://localhost:3000/api/character-templates/match \
  -H "Content-Type: application/json" \
  -d '{"taskText": "Meta広告のオーディエンスセグメント最適化"}'
```

実験ラボの「Compare」タブで複数ランの nDCG@5 を並べて比較できます。

---

## ステップ7: デプロイする

```bash
# ビルド確認
npm run build

# 本番デプロイ
vercel --prod --force
```

---

## よくある質問

**Q: 実験が途中で止まったように見える**
→ 非同期処理なので止まっていません。Historyタブで「running」→「done」になるまで待ってください。ページをリロードしても大丈夫です。

**Q: nDCG@5 が全然上がらない**
→ 問題がボキャブラリー（展開語の質）ではなく、そもそもDBにキャラクターがいない可能性が高いです。gap-detector.py の `suggest` コマンドを実行してください。

**Q: Gemini APIキーなしで使える？**
→ 使えます。auto-tune と gap-detector の Gemini 機能はスキップされますが、実験ラボ本体と基本分析は動きます。Judge ModelをOpenAIに変更すれば評価も動きます。

**Q: experiments.db をリセットしたい**
→ `rm experiments.db` で削除できます。サーバーを再起動すると空のDBが再作成されます。

**Q: auto-tune.py apply でコードを壊してしまった**
→ `git diff` で変更を確認して `git checkout server/routes/character-templates.ts server/lib/bm25.ts` で元に戻せます。

---

## ファイル・ディレクトリ構成

```
tools/eval-lab/
├── app.py                      # 実験ラボ本体（FastAPI）
├── auto-tune.py                # 自動チューニングスクリプト
├── gap-detector.py             # ギャップ検出スクリプト
├── requirements.txt            # Pythonライブラリ一覧
├── experiments.db              # 実験結果DB（自動生成）
├── auto-tune-report.md         # auto-tune の出力レポート（自動生成）
├── vocab-supplement.json       # ボキャブラリー補充データ（自動生成）
└── gap-reports/                # gap-detector の出力フォルダ（自動生成）
    ├── gap-report-*.md
    └── new-character-suggestions.json
```

---

## 改善サイクル（まとめ）

```
クエリ収集 → 実験ラボで投入 → 結果確認
     ↓
nDCG < 0.85 のクエリが多い？
     ↓
auto-tune.py all で自動改善
     ↓
まだゼロマッチが多い？
     ↓
gap-detector.py suggest でキャラクター追加提案を受ける
     ↓
スキルプレイブックに従ってDBにキャラクターを登録
     ↓
再実験 → スコア確認 → デプロイ
```

スコアが 0.95 以上になったら実用レベルです。
