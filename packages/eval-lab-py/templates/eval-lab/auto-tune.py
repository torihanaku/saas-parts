#!/usr/bin/env python3
"""
auto-tune.py — 実験データからマッチングシステムを自動改善

使い方:
  python auto-tune.py report                    # 全体分析レポートを生成
  python auto-tune.py vocab                     # 語彙シードの改善案を生成
  python auto-tune.py proficiency               # proficiency重みの最適化案を生成
  python auto-tune.py apply                     # 全改善をコードに適用（要確認）
  python auto-tune.py all                       # report + vocab + proficiency + apply を一括実行

オプション:
  --db PATH            experiments.db のパス (デフォルト: ./experiments.db)
  --ts PATH            character-templates.ts のパス
  --bm25-ts PATH       server/lib/bm25.ts のパス
  --min-queries N      最低クエリ数（少なすぎる場合はスキップ, デフォルト: 50）
  --weak-threshold N   弱クエリの閾値 (デフォルト: 0.85)
  --vocab-size N       語彙サプリメントのサイズ (デフォルト: 60)
  --yes                確認プロンプトをスキップ
"""

import sys
import json
import math
import sqlite3
import argparse
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

# ─── デフォルトパス ───────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT   = SCRIPT_DIR.parent.parent

DEFAULT_DB      = SCRIPT_DIR / "experiments.db"
DEFAULT_TS      = REPO_ROOT / "server" / "routes" / "character-templates.ts"
DEFAULT_BM25_TS = REPO_ROOT / "server" / "lib" / "bm25.ts"

# ─── データ読み込み ───────────────────────────────────────────────────────────

def load_results(db_path: Path, run_ids: list[str] | None = None) -> list[dict]:
    """SQLiteから全実験結果を読み込む"""
    if not db_path.exists():
        print(f"❌ DB が見つかりません: {db_path}")
        sys.exit(1)

    conn = sqlite3.connect(db_path)
    if run_ids:
        placeholders = ",".join(["?"] * len(run_ids))
        rows = conn.execute(
            f"""SELECT r.query, r.top5_names, r.top5_roles, r.top5_skills,
                       r.individual_scores, r.ndcg5, r.ranking_quality, r.comment,
                       r.run_id, ru.judge_model, ru.matching_mode, ru.notes
                FROM results r
                JOIN runs ru ON r.run_id = ru.id
                WHERE r.run_id IN ({placeholders}) AND r.error IS NULL
                ORDER BY r.id""",
            run_ids,
        ).fetchall()
    else:
        rows = conn.execute(
            """SELECT r.query, r.top5_names, r.top5_roles, r.top5_skills,
                      r.individual_scores, r.ndcg5, r.ranking_quality, r.comment,
                      r.run_id, ru.judge_model, ru.matching_mode, ru.notes
               FROM results r
               JOIN runs ru ON r.run_id = ru.id
               WHERE r.error IS NULL
               ORDER BY r.id"""
        ).fetchall()
    conn.close()

    results = []
    for row in rows:
        try:
            results.append({
                "query":    row[0],
                "top5":     json.loads(row[1]) if row[1] else [],
                "roles":    json.loads(row[2]) if row[2] else [],
                "skills":   json.loads(row[3]) if row[3] else [],   # list of lists
                "scores":   json.loads(row[4]) if row[4] else [],
                "ndcg5":    row[5],
                "quality":  row[6],
                "comment":  row[7],
                "run_id":   row[8],
                "model":    row[9],
                "mode":     row[10],
                "notes":    row[11],
            })
        except Exception:
            pass
    return results

# ─── コア分析関数 ─────────────────────────────────────────────────────────────

def split_weak_strong(results: list[dict], threshold: float) -> tuple[list, list]:
    weak   = [r for r in results if r["ndcg5"] is not None and r["ndcg5"] < threshold]
    strong = [r for r in results if r["ndcg5"] is not None and r["ndcg5"] >= threshold]
    return weak, strong


def compute_vocab_supplement(weak: list[dict], top_n: int = 60) -> list[tuple[str, int]]:
    """
    弱クエリ内でスコア >= 4 だったキャラクターのスキルを収集。
    これらは「LLMが正しいと判断したが上位に来なかったキャラの持つスキル」
    → vocabulary seedに追加するとBM25マッチ率が上がる。
    """
    freq: Counter = Counter()
    for r in weak:
        for skill_list, score in zip(r["skills"], r["scores"]):
            if score >= 4 and isinstance(skill_list, list):
                for skill in skill_list:
                    if skill and len(skill) >= 4:  # 短すぎるスキルは除外
                        freq[skill.strip()] += 1
    return freq.most_common(top_n)


def compute_false_top1(results: list[dict]) -> list[tuple[str, int, float]]:
    """
    Top1に来たが低スコア（1-2）だったキャラクターを集計。
    「誤って上位に来るキャラクター」 = BM25/セマンティックが過剰評価している。
    """
    char_bad_top1: dict[str, list[int]] = defaultdict(list)
    for r in results:
        if not r["top5"] or not r["scores"]:
            continue
        top1_name  = r["top5"][0]
        top1_score = r["scores"][0]
        if top1_score <= 2:
            char_bad_top1[top1_name].append(top1_score)

    result = []
    for name, scores in sorted(char_bad_top1.items(), key=lambda x: -len(x[1])):
        result.append((name, len(scores), sum(scores) / len(scores)))
    return result


def compute_proficiency_correlation(results: list[dict]) -> dict:
    """
    スコア (1-5) とキャラクターの役職名からproficiency推定。
    直接のproficiency情報は持っていないため、役職名末尾の Sr/Jr で推定。
    """
    level_scores: dict[str, list[int]] = {"Sr": [], "Jr": [], "standard": []}
    for r in results:
        for char_name, role, score in zip(r["top5"], r["roles"], r["scores"]):
            if char_name.endswith(" Sr"):
                level_scores["Sr"].append(score)
            elif char_name.endswith(" Jr"):
                level_scores["Jr"].append(score)
            else:
                level_scores["standard"].append(score)

    stats = {}
    for level, scores in level_scores.items():
        if scores:
            stats[level] = {"avg": round(sum(scores)/len(scores), 3), "count": len(scores)}
    return stats


def detect_zero_match_queries(results: list[dict]) -> list[dict]:
    """
    全Top5のスコアが <= 2 のクエリ = DBに適切なキャラが存在しない可能性大。
    """
    zero = []
    for r in results:
        if r["scores"] and max(r["scores"]) <= 2:
            zero.append(r)
    return zero


def cluster_queries_by_keywords(queries: list[str], top_k: int = 5) -> list[dict]:
    """
    シンプルなキーワードオーバーラップによるクラスタリング。
    LLM不要。
    """
    def tokenize(q):
        # 日本語: スペース区切り + カタカナ/英字のトークン
        tokens = set(re.findall(r'[ァ-ヺA-Za-z]{3,}|[\u4e00-\u9fff]{2,}', q))
        return tokens

    clusters = []
    assigned = set()

    for i, q in enumerate(queries):
        if i in assigned:
            continue
        cluster = {"center": q, "members": [q], "keywords": tokenize(q)}
        assigned.add(i)
        for j, q2 in enumerate(queries):
            if j in assigned or j == i:
                continue
            overlap = len(tokenize(q2) & cluster["keywords"])
            if overlap >= 2:
                cluster["members"].append(q2)
                cluster["keywords"] |= tokenize(q2)
                assigned.add(j)
        clusters.append(cluster)

    return sorted(clusters, key=lambda c: -len(c["members"]))[:top_k]


# ─── BM25 パラメータ最適化（プロキシ法） ─────────────────────────────────────

def bm25_proxy_score(skill_count: int, avg_count: float, k1: float, b: float) -> float:
    """TF=1のBM25正規化係数（キャラクターのスキル数に依存）"""
    return (k1 + 1) / (1 + k1 * (1 - b + b * (skill_count / avg_count)))


def optimize_bm25_params(weak: list[dict]) -> dict:
    """
    弱クエリでのランク vs スコアの相関を使ってBM25パラメータを探索。

    アプローチ:
    - Top5内で、スコア高いキャラが低いランク（rank 0 = 最良）のケースを数える
    - 「ランク逆転率」= 高スコアが低ランクに来る頻度
    - k1/b を変えることで（docLen依存の）スコアが変わる
    - matchedSkills数（= matched_skill_count）をdocLenの代理として使う
    - avg_doc_len は90（bulk-seedの既知値）
    """
    AVG_DOC_LEN = 90.0

    grid = {
        "k1": [0.75, 1.0, 1.25, 1.5, 1.75, 2.0],
        "b":  [0.3, 0.5, 0.75, 1.0],
    }

    best = {"k1": 1.5, "b": 0.75, "rank_inversion_rate": 1.0}

    total_inversions_current = 0
    total_pairs = 0

    for r in weak:
        skills_lists = r["skills"]
        scores       = r["scores"]
        if not skills_lists or not scores:
            continue

        for p in range(len(scores)):
            for q in range(p + 1, len(scores)):
                if scores[p] != scores[q]:
                    total_pairs += 1
                    # 現在のランク: p < q (p は上位)
                    # スコア: scores[p] vs scores[q]
                    if scores[p] < scores[q]:
                        total_inversions_current += 1

    current_rate = total_inversions_current / total_pairs if total_pairs > 0 else 0

    # k1/b のグリッドサーチ（匹数が多い場合のみ）
    best_rate = current_rate
    best_k1, best_b = 1.5, 0.75

    for k1 in grid["k1"]:
        for b in grid["b"]:
            inversions = 0
            pairs = 0
            for r in weak:
                skills_lists = r["skills"]
                scores = r["scores"]
                if not skills_lists or not scores:
                    continue
                # 各キャラのmatchedSkill数 → proxy doc length
                match_counts = [len(sl) if isinstance(sl, list) else 0 for sl in skills_lists]
                # 再スコアリング（IDFは一定と仮定）
                rescored = [bm25_proxy_score(mc, AVG_DOC_LEN, k1, b) * (i + 1)
                            for i, mc in enumerate(match_counts)]  # 元ranKでIDF的な補正

                # ランク逆転をカウント
                for p in range(len(scores)):
                    for q in range(p + 1, len(scores)):
                        if scores[p] != scores[q]:
                            pairs += 1
                            expected_better = p  # 元々pが上位
                            if rescored[p] < rescored[q] and scores[p] < scores[q]:
                                pass  # 改善
                            elif rescored[p] > rescored[q] and scores[p] < scores[q]:
                                inversions += 1

            rate = inversions / pairs if pairs > 0 else 0
            if rate < best_rate:
                best_rate = rate
                best_k1 = k1
                best_b = b

    return {
        "current_k1": 1.5, "current_b": 0.75,
        "current_rank_inversion_rate": round(current_rate, 4),
        "best_k1": best_k1, "best_b": best_b,
        "best_rank_inversion_rate": round(best_rate, 4),
        "improvement": round(current_rate - best_rate, 4),
        "total_pairs": total_pairs,
    }


def suggest_proficiency_weights(results: list[dict]) -> dict:
    """
    Sr/Jr/standard の平均スコアから proficiency重みの調整を提案。
    """
    stats = compute_proficiency_correlation(results)
    suggestions = {}

    if "Sr" in stats and "Jr" in stats:
        sr_avg = stats["Sr"]["avg"]
        jr_avg = stats["Jr"]["avg"]
        std_avg = stats.get("standard", {}).get("avg", 3.0)

        # Sr が standard より低い → expert重みを下げる可能性
        if sr_avg < std_avg - 0.3:
            suggestions["expert"] = round(1.25 * (sr_avg / std_avg), 2)
            suggestions["note"] = "Sr キャラのスコアが想定より低い。expert重みを下げることを検討。"
        # Jr が standard より高い → beginner重みを上げる可能性
        elif jr_avg > std_avg + 0.2:
            suggestions["beginner"] = round(0.6 * (jr_avg / std_avg), 2)
            suggestions["note"] = "Jr キャラのスコアが想定より高い。beginner重みを上げることを検討。"
        else:
            suggestions["note"] = "現在の proficiency 重みは適切です（変更不要）。"

    return {"stats": stats, "suggestions": suggestions}


# ─── レポート生成 ─────────────────────────────────────────────────────────────

def cmd_report(results: list[dict], threshold: float) -> str:
    weak, strong = split_weak_strong(results, threshold)
    all_ndcg = [r["ndcg5"] for r in results if r["ndcg5"] is not None]
    zero = detect_zero_match_queries(results)

    lines = [
        f"# Auto-Tune 分析レポート",
        f"",
        f"**生成日時**: {datetime.now().strftime('%Y-%m-%d %H:%M')}  ",
        f"**データ**: {len(results)}件のクエリ（{len(set(r['run_id'] for r in results))}実験）",
        f"",
        f"## 全体スコアサマリー",
        f"",
        f"| 指標 | 値 |",
        f"|------|----|",
        f"| 全クエリ数 | {len(all_ndcg)}件 |",
        f"| nDCG@5 平均 | **{sum(all_ndcg)/len(all_ndcg):.4f}** |" if all_ndcg else "| nDCG@5 平均 | — |",
        f"| 弱クエリ（< {threshold}） | {len(weak)}件（{len(weak)/len(all_ndcg)*100:.0f}%）|" if all_ndcg else "",
        f"| ゼロマッチクエリ（全スコア≤2） | {len(zero)}件 |",
        f"| nDCG@5 ≥ 0.95 | {sum(1 for v in all_ndcg if v >= 0.95)}件 |",
        f"",
    ]

    # 弱クエリ上位
    if weak:
        lines += [
            f"## 弱クエリ一覧（nDCG < {threshold}、上位30件）",
            f"",
            f"| クエリ | Top1 | スコア | nDCG@5 |",
            f"|--------|------|--------|--------|",
        ]
        for r in sorted(weak, key=lambda x: x["ndcg5"])[:30]:
            top1 = r["top5"][0] if r["top5"] else "—"
            scores_str = str(r["scores"])
            lines.append(f"| {r['query'][:60]} | {top1} | {scores_str} | {r['ndcg5']:.3f} |")
        lines.append("")

    # 誤Top1キャラクター
    false_top1 = compute_false_top1(results)
    if false_top1:
        lines += [
            f"## Top1 に誤って来るキャラクター（改善の優先度が高い）",
            f"",
            f"| キャラクター名 | 誤Top1回数 | 平均スコア |",
            f"|--------------|-----------|-----------|",
        ]
        for name, cnt, avg_score in false_top1[:10]:
            lines.append(f"| {name} | {cnt}回 | {avg_score:.2f} |")
        lines.append("")

    # ゼロマッチクエリのクラスタリング
    if zero:
        clusters = cluster_queries_by_keywords([r["query"] for r in zero])
        lines += [
            f"## DB不足クエリのクラスター（キャラクター追加が必要な領域）",
            f"",
        ]
        for i, c in enumerate(clusters, 1):
            lines.append(f"### クラスター {i}（{len(c['members'])}件）")
            lines.append(f"代表クエリ: 「{c['center']}」")
            lines.append(f"含まれるクエリ: {', '.join([m[:30] for m in c['members'][:5]])}")
            lines.append("")

    # BM25パラメータ分析
    bm25 = optimize_bm25_params(weak)
    lines += [
        f"## BM25 パラメータ分析",
        f"",
        f"| パラメータ | 現在値 | 提案値 |",
        f"|----------|--------|--------|",
        f"| k1 | {bm25['current_k1']} | **{bm25['best_k1']}** |",
        f"| b  | {bm25['current_b']} | **{bm25['best_b']}** |",
        f"",
        f"- ランク逆転率: {bm25['current_rank_inversion_rate']:.1%} → {bm25['best_rank_inversion_rate']:.1%}（改善: {bm25['improvement']:.1%}）",
        f"- 分析対象ペア数: {bm25['total_pairs']}組",
        f"",
    ]
    if bm25["improvement"] < 0.01:
        lines.append("> 💡 BM25パラメータは現在値が最適に近いです。改善余地は語彙シードにあります。\n")

    # Proficiency重み
    prof = suggest_proficiency_weights(results)
    lines += [
        f"## Proficiency重み分析",
        f"",
    ]
    for level, stat in prof["stats"].items():
        lines.append(f"- **{level}**: 平均スコア {stat['avg']} （{stat['count']}件）")
    if prof["suggestions"].get("note"):
        lines.append(f"\n💡 {prof['suggestions']['note']}")
    lines.append("")

    return "\n".join(lines)


# ─── 語彙シード生成 ───────────────────────────────────────────────────────────

def cmd_vocab(results: list[dict], threshold: float, top_n: int) -> dict:
    weak, _ = split_weak_strong(results, threshold)
    vocab = compute_vocab_supplement(weak, top_n)

    output = {
        "generated_at": datetime.now().isoformat(),
        "source_queries": len(results),
        "weak_queries": len(weak),
        "threshold": threshold,
        "vocab_supplement": [{"skill": s, "frequency": f} for s, f in vocab],
    }
    return output


# ─── コードへのパッチ適用 ──────────────────────────────────────────────────────

VOCAB_MARKER_START = "// ─── AUTO-TUNED PRIORITY VOCAB (do not edit manually) ─────────────────"
VOCAB_MARKER_END   = "// ─────────────────────────────────────────────────────────────────────────"

def apply_vocab_patch_to_ts(ts_path: Path, vocab_list: list[str], source_stats: dict) -> bool:
    """
    character-templates.ts に AUTO_TUNED_VOCAB 定数を挿入/更新する。
    挿入後、getSkillVocabulary() がこれを先頭に連結するよう修正する。
    """
    if not ts_path.exists():
        print(f"❌ {ts_path} が見つかりません")
        return False

    content = ts_path.read_text(encoding="utf-8")

    # 語彙リストをTypeScriptの配列文字列に変換
    vocab_entries = "\n".join(f'  "{s}",' for s in vocab_list)
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    n_queries = source_stats.get("source_queries", "?")
    n_weak    = source_stats.get("weak_queries", "?")

    new_block = (
        f"{VOCAB_MARKER_START}\n"
        f"// Last updated: {now} by tools/eval-lab/auto-tune.py\n"
        f"// Source: {n_queries}件クエリ / {n_weak}件弱クエリから抽出\n"
        f"const AUTO_TUNED_VOCAB: string[] = [\n"
        f"{vocab_entries}\n"
        f"];\n"
        f"{VOCAB_MARKER_END}"
    )

    # 既存ブロックがあれば置換、なければ skillVocabCache の前に挿入
    if VOCAB_MARKER_START in content:
        pattern = re.compile(
            re.escape(VOCAB_MARKER_START) + r".*?" + re.escape(VOCAB_MARKER_END),
            re.DOTALL,
        )
        content = pattern.sub(new_block, content)
    else:
        # skillVocabCache 宣言の直前に挿入
        content = content.replace(
            "let skillVocabCache: string[] | null = null;",
            f"{new_block}\n\nlet skillVocabCache: string[] | null = null;",
        )

    # getSkillVocabulary() で AUTO_TUNED_VOCAB を先頭に連結するよう修正
    # 既に修正済みなら何もしない
    if "AUTO_TUNED_VOCAB" not in content.split("getSkillVocabulary")[1][:500] if "getSkillVocabulary" in content else True:
        # skillVocabCache = rows.map(...) の行を修正
        content = re.sub(
            r"skillVocabCache = rows\.map\(r => r\.skill_name\);",
            "skillVocabCache = [...AUTO_TUNED_VOCAB, ...rows.map(r => r.skill_name)];",
            content,
        )

    ts_path.write_text(content, encoding="utf-8")
    return True


def apply_bm25_patch(bm25_ts_path: Path, k1: float, b: float) -> bool:
    """server/lib/bm25.ts の BM25_K1 / BM25_B を更新する"""
    if not bm25_ts_path.exists():
        print(f"❌ {bm25_ts_path} が見つかりません")
        return False

    content = bm25_ts_path.read_text(encoding="utf-8")
    content = re.sub(r"export const BM25_K1 = [\d.]+;", f"export const BM25_K1 = {k1};", content)
    content = re.sub(r"export const BM25_B\s+=\s+[\d.]+;", f"export const BM25_B  = {b};", content)
    bm25_ts_path.write_text(content, encoding="utf-8")
    return True


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="マッチングシステム自動チューニング")
    parser.add_argument("command", nargs="?", default="report",
                        choices=["report", "vocab", "proficiency", "apply", "all"],
                        help="実行するコマンド")
    parser.add_argument("--db",             default=str(DEFAULT_DB))
    parser.add_argument("--ts",             default=str(DEFAULT_TS))
    parser.add_argument("--bm25-ts",        default=str(DEFAULT_BM25_TS))
    parser.add_argument("--min-queries",    type=int, default=50)
    parser.add_argument("--weak-threshold", type=float, default=0.85)
    parser.add_argument("--vocab-size",     type=int, default=60)
    parser.add_argument("--run-ids",        default=None,
                        help="分析対象のRun ID（カンマ区切り）。省略時は全データ")
    parser.add_argument("--yes", "-y",      action="store_true",
                        help="確認プロンプトをスキップ")
    args = parser.parse_args()

    db_path     = Path(args.db)
    ts_path     = Path(args.ts)
    bm25_ts     = Path(args.bm25_ts)
    run_ids     = [x.strip() for x in args.run_ids.split(",")] if args.run_ids else None
    threshold   = args.weak_threshold
    vocab_size  = args.vocab_size

    # データ読み込み
    print(f"\n📂 DB 読み込み: {db_path}")
    results = load_results(db_path, run_ids)
    print(f"   {len(results)}件のクエリを読み込みました")

    if len(results) < args.min_queries:
        print(f"⚠️  データが少なすぎます（{len(results)}件 < {args.min_queries}件）。実験をさらに蓄積してください。")
        print(f"   --min-queries {len(results)} で強制実行できます。")
        sys.exit(0)

    cmd = args.command

    # ── report ──────────────────────────────────────────────────────────────
    if cmd in ("report", "all"):
        print("\n📊 分析レポートを生成中...")
        report = cmd_report(results, threshold)
        out_path = SCRIPT_DIR / "auto-tune-report.md"
        out_path.write_text(report, encoding="utf-8")
        print(f"   ✅ 保存: {out_path}")
        if cmd == "report":
            print("\n" + "="*60)
            print(report[:2000])
            if len(report) > 2000:
                print(f"... (全文は {out_path} を参照)")

    # ── vocab ────────────────────────────────────────────────────────────────
    if cmd in ("vocab", "all"):
        print("\n🧬 語彙サプリメントを生成中...")
        vocab_data = cmd_vocab(results, threshold, vocab_size)
        out_json = SCRIPT_DIR / "vocab-supplement.json"
        out_json.write_text(json.dumps(vocab_data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"   ✅ 保存: {out_json}")

        top_vocab = [v["skill"] for v in vocab_data["vocab_supplement"]]
        print(f"   追加候補: {len(top_vocab)}スキル")
        print(f"   上位10件: {', '.join(top_vocab[:10])}")

    # ── proficiency ──────────────────────────────────────────────────────────
    if cmd in ("proficiency", "all"):
        print("\n⚖️  Proficiency重みを分析中...")
        prof = suggest_proficiency_weights(results)
        print("   Sr/Jr/standard の平均スコア:")
        for level, stat in prof["stats"].items():
            print(f"     {level:10s}: {stat['avg']} （{stat['count']}件）")
        print(f"   → {prof['suggestions'].get('note', '分析対象データが不足しています')}")

        bm25_result = optimize_bm25_params([r for r in results if r["ndcg5"] and r["ndcg5"] < threshold])
        print(f"\n   BM25パラメータ提案: k1={bm25_result['best_k1']}, b={bm25_result['best_b']}")
        print(f"   現在 rank_inversion_rate={bm25_result['current_rank_inversion_rate']:.1%} "
              f"→ 提案後 {bm25_result['best_rank_inversion_rate']:.1%}")

    # ── apply ────────────────────────────────────────────────────────────────
    if cmd in ("apply", "all"):
        print("\n🔧 コードへの適用...")

        # 語彙サプリメントが未生成なら生成
        vocab_json = SCRIPT_DIR / "vocab-supplement.json"
        if not vocab_json.exists():
            vocab_data = cmd_vocab(results, threshold, vocab_size)
            vocab_json.write_text(json.dumps(vocab_data, ensure_ascii=False, indent=2))
        else:
            vocab_data = json.loads(vocab_json.read_text(encoding="utf-8"))

        top_vocab = [v["skill"] for v in vocab_data["vocab_supplement"]]

        if not args.yes:
            print(f"\n   適用予定の変更:")
            print(f"   1. {ts_path}")
            print(f"      → AUTO_TUNED_VOCAB に {len(top_vocab)}スキルを設定")
            print(f"   2. {bm25_ts}")

            bm25_result = optimize_bm25_params([r for r in results if r["ndcg5"] and r["ndcg5"] < threshold])
            if bm25_result["improvement"] >= 0.01:
                print(f"      → BM25_K1={bm25_result['best_k1']}, BM25_B={bm25_result['best_b']} に更新")
            else:
                print(f"      → BM25パラメータは変更なし（現在値が最適）")

            ans = input("\n   適用しますか？ [y/N] ").strip().lower()
            if ans != "y":
                print("   キャンセルしました。")
                return

        # 語彙シードパッチ適用
        ok = apply_vocab_patch_to_ts(ts_path, top_vocab, vocab_data)
        if ok:
            print(f"   ✅ {ts_path.name}: AUTO_TUNED_VOCAB 更新済み（{len(top_vocab)}スキル）")

        # BM25パラメータパッチ（改善率が1%以上の場合のみ）
        bm25_result = optimize_bm25_params([r for r in results if r["ndcg5"] and r["ndcg5"] < threshold])
        if bm25_result["improvement"] >= 0.01:
            ok = apply_bm25_patch(bm25_ts, bm25_result["best_k1"], bm25_result["best_b"])
            if ok:
                print(f"   ✅ {bm25_ts.name}: k1={bm25_result['best_k1']}, b={bm25_result['best_b']} に更新")
        else:
            print(f"   ℹ️  BM25パラメータ: 変更なし（改善率 {bm25_result['improvement']:.1%} < 1%）")

        print(f"\n🎉 適用完了！次のステップ:")
        print(f"   1. git diff で変更内容を確認")
        print(f"   2. bun run server/scripts/evaluate-matching.ts --mode hybrid で効果確認")
        print(f"   3. 問題なければ git commit してデプロイ")


if __name__ == "__main__":
    main()
