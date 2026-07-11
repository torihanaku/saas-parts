#!/usr/bin/env python3
"""
gap-detector.py — ゼロマッチ・低スコアクエリからキャラクター不足を検出する

使い方:
  python gap-detector.py detect                  # ギャップ検出 (最新ラン)
  python gap-detector.py detect --run <run_id>   # 特定ラン
  python gap-detector.py detect --all-runs       # 全ラン集計
  python gap-detector.py suggest                 # Gemini APIでキャラクター提案 (要APIキー)
  python gap-detector.py report                  # テキストレポート出力
"""

import argparse
import json
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

DB_PATH = Path(__file__).parent / "experiments.db"
OUTPUT_DIR = Path(__file__).parent / "gap-reports"

# ギャップ判定しきい値
WEAK_NDCG_THRESHOLD = 0.85   # これ未満は弱いクエリ
ZERO_MATCH_SCORE = 1.0       # top1スコアがこれ以下 = ほぼマッチなし判定

# Gemini API (オプション)
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = "gemini-2.0-flash"


# ─── DB ─────────────────────────────────────────────────────────────────────

def get_conn() -> sqlite3.Connection:
    if not DB_PATH.exists():
        print(f"[ERROR] DBが見つかりません: {DB_PATH}")
        print("先に eval-lab (app.py) で実験を実行してください。")
        sys.exit(1)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def fetch_runs(conn: sqlite3.Connection, run_id: int | None = None, all_runs: bool = False):
    if run_id:
        rows = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchall()
    elif all_runs:
        rows = conn.execute("SELECT * FROM runs ORDER BY id DESC").fetchall()
    else:
        rows = conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchall()
    return [dict(r) for r in rows]


def fetch_results(conn: sqlite3.Connection, run_ids: list[int]) -> list[dict]:
    placeholders = ",".join("?" * len(run_ids))
    rows = conn.execute(
        f"SELECT * FROM results WHERE run_id IN ({placeholders})",
        run_ids,
    ).fetchall()
    return [dict(r) for r in rows]


# ─── ギャップ分析ロジック ────────────────────────────────────────────────────

def parse_scores(scores_json: str) -> list[int]:
    try:
        return json.loads(scores_json)
    except Exception:
        return []


def parse_top5_skills(skills_json: str | None) -> list[list[str]]:
    if not skills_json:
        return []
    try:
        return json.loads(skills_json)
    except Exception:
        return []


def is_weak(result: dict) -> bool:
    return float(result.get("ndcg5", 1.0)) < WEAK_NDCG_THRESHOLD


def is_zero_match(result: dict) -> bool:
    scores = parse_scores(result.get("scores", "[]"))
    return not scores or (scores[0] <= ZERO_MATCH_SCORE)


def extract_keywords(text: str) -> list[str]:
    """クエリから簡易キーワード抽出（品詞分解なし）"""
    # 記号を除去して分割
    text = re.sub(r"[、。・「」【】（）()・\-]", " ", text)
    tokens = text.split()
    # 2文字以上の単語のみ
    return [t for t in tokens if len(t) >= 2]


def cluster_by_keywords(weak_queries: list[str]) -> dict[str, list[str]]:
    """キーワード頻度でクエリをゆるくクラスタリング"""
    keyword_to_queries: dict[str, list[str]] = defaultdict(list)
    for q in weak_queries:
        for kw in extract_keywords(q):
            keyword_to_queries[kw].append(q)

    # 2件以上に出てくるキーワードだけ残す
    clusters = {k: list(set(v)) for k, v in keyword_to_queries.items() if len(set(v)) >= 2}
    # 多い順
    return dict(sorted(clusters.items(), key=lambda x: len(x[1]), reverse=True))


def analyze_gaps(results: list[dict]) -> dict:
    """ギャップ分析のメイン処理"""
    total = len(results)
    weak = [r for r in results if is_weak(r)]
    zero = [r for r in results if is_zero_match(r)]

    weak_queries = [r["query"] for r in weak]
    zero_queries = [r["query"] for r in zero]

    # スキルギャップ: 弱いクエリのtop5_skillsから、どんなスキルを期待すべきか
    expected_skill_freq: Counter = Counter()
    for r in weak:
        skills_per_char = parse_top5_skills(r.get("top5_skills"))
        scores = parse_scores(r.get("scores", "[]"))
        for skill_list, score in zip(skills_per_char, scores):
            if score >= 4:  # スコア4以上 = 近い答えだが順位が悪い
                for skill in skill_list:
                    expected_skill_freq[skill.strip()] += 1

    # キーワードクラスタリング
    clusters = cluster_by_keywords(weak_queries)
    top_clusters = dict(list(clusters.items())[:20])

    # キーワード頻度（ゼロマッチ専用）
    zero_kw_freq: Counter = Counter()
    for q in zero_queries:
        for kw in extract_keywords(q):
            zero_kw_freq[kw] += 1

    return {
        "summary": {
            "total_queries": total,
            "weak_queries": len(weak),
            "zero_match_queries": len(zero),
            "weak_rate": round(len(weak) / total * 100, 1) if total else 0,
            "zero_match_rate": round(len(zero) / total * 100, 1) if total else 0,
        },
        "weak_queries": weak_queries,
        "zero_queries": zero_queries,
        "expected_skills_freq": dict(expected_skill_freq.most_common(40)),
        "keyword_clusters": top_clusters,
        "zero_match_keywords": dict(zero_kw_freq.most_common(30)),
    }


# ─── Gemini API でキャラクター提案 ─────────────────────────────────────────

def suggest_characters_with_gemini(gap_data: dict) -> list[dict]:
    """Gemini APIで不足キャラクタータイプを提案"""
    try:
        import urllib.request
    except ImportError:
        print("[WARN] urllib が使えません")
        return []

    if not GEMINI_API_KEY:
        print("[WARN] GEMINI_API_KEY が設定されていません。スキップします。")
        return []

    weak_sample = gap_data["weak_queries"][:20]
    zero_sample = gap_data["zero_queries"][:10]
    top_skills = list(gap_data["expected_skills_freq"].keys())[:20]
    top_clusters = list(gap_data["keyword_clusters"].keys())[:15]

    prompt = f"""あなたはBtoB SaaSマーケティング特化の人材マッチングシステムの設計者です。

以下は、現在のキャラクターDBで上手くマッチングできなかったクエリの分析データです。

## マッチ率が低かったクエリ（サンプル）
{json.dumps(weak_sample, ensure_ascii=False, indent=2)}

## ほぼマッチしなかったクエリ（サンプル）
{json.dumps(zero_sample, ensure_ascii=False, indent=2)}

## 期待されていたスキル（高スコアキャラに含まれるはずのスキル）
{", ".join(top_skills)}

## 頻出キーワードクラスター
{", ".join(top_clusters)}

---

上記のデータから、DBに「登録すべきキャラクタータイプ」を5〜10件提案してください。
各キャラクターは以下のJSON形式で返してください。余分なテキストは不要です。

[
  {{
    "name": "キャラクター名（例: Meta広告スペシャリスト）",
    "role": "役職（例: デジタルマーケター）",
    "rationale": "なぜ必要か（1行）",
    "core_skills": ["スキル1", "スキル2", "スキル3", "スキル4", "スキル5"],
    "target_queries": ["このキャラがマッチするクエリ例1", "クエリ例2"]
  }}
]
"""

    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 2048},
    }).encode()

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    )
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        # JSONブロック抽出
        m = re.search(r"\[.*\]", text, re.DOTALL)
        if m:
            return json.loads(m.group(0))
        print("[WARN] GeminiレスポンスからJSONを抽出できませんでした")
        print(text[:500])
        return []
    except Exception as e:
        print(f"[ERROR] Gemini API呼び出し失敗: {e}")
        return []


# ─── レポート生成 ────────────────────────────────────────────────────────────

def format_report(gap_data: dict, suggestions: list[dict], run_info: list[dict]) -> str:
    s = gap_data["summary"]
    lines = [
        "# ギャップ検出レポート",
        "",
        "## サマリー",
        f"- 対象クエリ数: {s['total_queries']}",
        f"- 弱いクエリ (nDCG<{WEAK_NDCG_THRESHOLD}): {s['weak_queries']} ({s['weak_rate']}%)",
        f"- ゼロマッチ: {s['zero_match_queries']} ({s['zero_match_rate']}%)",
        "",
    ]

    if run_info:
        lines += ["## 対象ラン"]
        for r in run_info:
            lines.append(f"- Run#{r['id']} | {r['name']} | {r.get('judge_model','?')} | {r.get('created_at','')}")
        lines.append("")

    lines += [
        "## ゼロマッチクエリ（上位）",
    ]
    for q in gap_data["zero_queries"][:15]:
        lines.append(f"- {q}")
    lines.append("")

    lines += [
        "## 弱いクエリに期待されていたスキル",
        "（高スコアキャラに含まれるスキル → 追加すべきスキルの候補）",
    ]
    for skill, cnt in list(gap_data["expected_skills_freq"].items())[:20]:
        lines.append(f"  {cnt:3d}回  {skill}")
    lines.append("")

    lines += ["## キーワードクラスター（ギャップ領域）"]
    for kw, queries in list(gap_data["keyword_clusters"].items())[:15]:
        lines.append(f"### `{kw}` （{len(queries)}クエリ）")
        for q in queries[:3]:
            lines.append(f"  - {q}")
    lines.append("")

    if suggestions:
        lines += ["## 追加推奨キャラクター（Gemini提案）"]
        for i, s in enumerate(suggestions, 1):
            lines.append(f"### {i}. {s.get('name','?')} — {s.get('role','?')}")
            lines.append(f"**理由**: {s.get('rationale','')}")
            lines.append(f"**コアスキル**: {', '.join(s.get('core_skills',[]))}")
            lines.append(f"**対応クエリ例**: {', '.join(s.get('target_queries',[]))}")
            lines.append("")

    return "\n".join(lines)


def save_suggestions_json(suggestions: list[dict], gap_data: dict, output_path: Path) -> None:
    out = {
        "generated_at": __import__("datetime").datetime.now().isoformat(),
        "summary": gap_data["summary"],
        "suggested_characters": suggestions,
        "gap_analysis": {
            "top_missing_skills": list(gap_data["expected_skills_freq"].items())[:30],
            "keyword_clusters": {k: v[:5] for k, v in list(gap_data["keyword_clusters"].items())[:20]},
            "zero_match_keywords": list(gap_data["zero_match_keywords"].items())[:20],
        },
    }
    output_path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"[OK] キャラクター提案JSON: {output_path}")


# ─── CLI ─────────────────────────────────────────────────────────────────────

def cmd_detect(args: argparse.Namespace) -> dict:
    conn = get_conn()
    runs = fetch_runs(conn, run_id=getattr(args, "run", None), all_runs=getattr(args, "all_runs", False))
    if not runs:
        print("[ERROR] ランが見つかりません")
        sys.exit(1)

    run_ids = [r["id"] for r in runs]
    print(f"[INFO] 分析対象ラン: {run_ids}")
    results = fetch_results(conn, run_ids)
    print(f"[INFO] 結果件数: {len(results)}")

    gap_data = analyze_gaps(results)
    s = gap_data["summary"]
    print(f"\n弱いクエリ: {s['weak_queries']}/{s['total_queries']} ({s['weak_rate']}%)")
    print(f"ゼロマッチ: {s['zero_match_queries']}/{s['total_queries']} ({s['zero_match_rate']}%)")

    return gap_data, runs


def cmd_suggest(args: argparse.Namespace) -> None:
    gap_data, runs = cmd_detect(args)

    print("\n[INFO] Gemini APIでキャラクター提案を生成中...")
    suggestions = suggest_characters_with_gemini(gap_data)

    OUTPUT_DIR.mkdir(exist_ok=True)
    ts = __import__("datetime").datetime.now().strftime("%Y%m%d-%H%M%S")

    json_path = OUTPUT_DIR / f"new-character-suggestions-{ts}.json"
    save_suggestions_json(suggestions, gap_data, json_path)
    # latest にもコピー
    latest_path = OUTPUT_DIR / "new-character-suggestions.json"
    latest_path.write_text(json_path.read_text())

    report_path = OUTPUT_DIR / f"gap-report-{ts}.md"
    report = format_report(gap_data, suggestions, runs)
    report_path.write_text(report)
    print(f"[OK] レポート: {report_path}")


def cmd_report(args: argparse.Namespace) -> None:
    gap_data, runs = cmd_detect(args)

    OUTPUT_DIR.mkdir(exist_ok=True)
    ts = __import__("datetime").datetime.now().strftime("%Y%m%d-%H%M%S")
    report_path = OUTPUT_DIR / f"gap-report-{ts}.md"
    report = format_report(gap_data, [], runs)
    report_path.write_text(report)
    print(f"\n[OK] レポート: {report_path}")
    print("\n─── レポート冒頭 ───────────────────────────────────────────────")
    print("\n".join(report.split("\n")[:40]))


def main():
    parser = argparse.ArgumentParser(description="gap-detector: ギャップクエリ分析ツール")
    sub = parser.add_subparsers(dest="command")

    for cmd_name in ("detect", "suggest", "report"):
        p = sub.add_parser(cmd_name)
        p.add_argument("--run", type=int, help="特定のラン ID")
        p.add_argument("--all-runs", action="store_true", help="全ランを集計")

    args = parser.parse_args()

    if args.command == "detect":
        gap_data, _ = cmd_detect(args)
        print("\n上位ゼロマッチキーワード:")
        for kw, cnt in list(gap_data["zero_match_keywords"].items())[:10]:
            print(f"  {cnt}件  {kw}")
    elif args.command == "suggest":
        cmd_suggest(args)
    elif args.command == "report":
        cmd_report(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
