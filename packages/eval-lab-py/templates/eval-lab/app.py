#!/usr/bin/env python3
"""
eval-lab/app.py — マッチング評価実験ツール

起動:
  cd tools/eval-lab
  pip install -r requirements.txt
  python app.py
  open http://localhost:8100
"""

import asyncio
import aiohttp
import sqlite3
import uuid
import json
import csv
import io
import math
import os
import re
from collections import defaultdict
from datetime import datetime
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, BackgroundTasks, UploadFile, Form, File
from fastapi.responses import HTMLResponse, JSONResponse, Response

DB_PATH = Path(__file__).parent / "experiments.db"

# ─── DB ─────────────────────────────────────────────────────────────────────

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS runs (
            id                TEXT PRIMARY KEY,
            name              TEXT NOT NULL,
            created_at        TEXT NOT NULL,
            status            TEXT NOT NULL DEFAULT 'pending',
            total_queries     INTEGER NOT NULL DEFAULT 0,
            completed_queries INTEGER NOT NULL DEFAULT 0,
            failed_queries    INTEGER NOT NULL DEFAULT 0,
            judge_model       TEXT NOT NULL,
            api_endpoint      TEXT NOT NULL,
            matching_mode     TEXT NOT NULL DEFAULT 'hybrid',
            concurrency       INTEGER NOT NULL DEFAULT 5,
            avg_ndcg5         REAL,
            notes             TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS results (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id               TEXT NOT NULL,
            query                TEXT NOT NULL,
            top5_names           TEXT,   -- JSON ["name1","name2",...]
            top5_roles           TEXT,   -- JSON ["role1","role2",...]
            top5_ids             TEXT,   -- JSON ["id1","id2",...]  ← fine-tuning用
            top5_skills          TEXT,   -- JSON [["skill1","skill2",...], ...]  ← fine-tuning用
            individual_scores    TEXT,   -- JSON [5,4,3,2,1]
            ndcg5                REAL,
            ranking_quality      INTEGER,
            comment              TEXT,
            latency_ms           INTEGER,
            error                TEXT,
            created_at           TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id)
        )
    """)
    # Migration: add columns if they don't exist (for existing DBs)
    for col, typedef in [
        ("top5_ids",   "TEXT"),
        ("top5_skills","TEXT"),
    ]:
        try:
            conn.execute(f"ALTER TABLE results ADD COLUMN {col} {typedef}")
        except Exception:
            pass
    conn.commit()
    conn.close()

def db_write(sql: str, params: tuple):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(sql, params)
    conn.commit()
    conn.close()

# ─── nDCG@5 ─────────────────────────────────────────────────────────────────

def ndcg_at_5(scores: list) -> float:
    if not scores:
        return 0.0
    def dcg(rels):
        return sum((2**r - 1) / math.log2(i + 2) for i, r in enumerate(rels))
    s = scores[:5]
    ideal_dcg = dcg(sorted(s, reverse=True))
    return dcg(s) / ideal_dcg if ideal_dcg > 0 else 0.0

# ─── LLM Judge ──────────────────────────────────────────────────────────────

JUDGE_PROMPT = """あなたはAIキャラクターマッチングシステムの評価者です。

ユーザーの依頼:
{query}

マッチングシステムが返したTop5のキャラクター:
{characters}

各キャラクターが「このユーザーの依頼にどれだけ適しているか」を1〜5点で評価してください。
5=完璧にマッチ、4=かなり適している、3=関連あり、2=あまり関係ない、1=無関係

以下のJSON形式のみで返してください:
{{"scores": [score1, score2, score3, score4, score5], "quality": 1, "comment": "一行コメント"}}

quality: 1=ランキング順序が悪い(良いキャラが下位)、2=普通、3=ランキング順序が良い"""

def _fmt_characters(characters: list) -> str:
    lines = []
    for i, c in enumerate(characters):
        skills = ", ".join(c.get("skills", [])[:4])
        lines.append(f"{i+1}. {c['name']}（{c.get('role', '')}）: {skills}")
    return "\n".join(lines)

def _parse_judge_response(text: str) -> dict:
    text = re.sub(r"```(?:json)?\s*|\s*```", "", text).strip()
    m = re.search(r'\{.*\}', text, re.DOTALL)
    if m:
        return json.loads(m.group())
    raise ValueError(f"No JSON found in: {text[:200]}")

async def judge_with_openai(query: str, characters: list, api_key: str, model: str) -> dict:
    prompt = JUDGE_PROMPT.format(query=query, characters=_fmt_characters(characters))
    async with aiohttp.ClientSession() as session:
        async with session.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "response_format": {"type": "json_object"},
                "temperature": 0,
            },
            timeout=aiohttp.ClientTimeout(total=30),
        ) as resp:
            data = await resp.json()
            if resp.status != 200:
                raise ValueError(f"OpenAI {resp.status}: {data.get('error',{}).get('message','')}")
            return json.loads(data["choices"][0]["message"]["content"])

async def judge_with_gemini(query: str, characters: list, api_key: str, model: str) -> dict:
    prompt = JUDGE_PROMPT.format(query=query, characters=_fmt_characters(characters))
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    async with aiohttp.ClientSession() as session:
        async with session.post(
            url,
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
            },
            timeout=aiohttp.ClientTimeout(total=30),
        ) as resp:
            data = await resp.json()
            if resp.status != 200:
                raise ValueError(f"Gemini {resp.status}: {data.get('error',{}).get('message',str(data))}")
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            return _parse_judge_response(text)

async def judge_query(query: str, characters: list, model: str, api_key: str) -> dict:
    try:
        if model.startswith("gpt-") or model.startswith("o1") or model.startswith("o3"):
            return await judge_with_openai(query, characters, api_key, model)
        elif model.startswith("gemini"):
            return await judge_with_gemini(query, characters, api_key, model)
        else:
            raise ValueError(f"Unknown model: {model}")
    except Exception as e:
        return {"scores": [3, 3, 3, 3, 3], "quality": 2, "comment": f"[judge error] {str(e)[:120]}"}

# ─── Matching API ────────────────────────────────────────────────────────────

async def call_matching_api(query: str, endpoint: str, mode: str, auth_header: Optional[str]) -> dict:
    headers = {"Content-Type": "application/json"}
    if auth_header:
        headers["Authorization"] = auth_header

    t_start = asyncio.get_event_loop().time()
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{endpoint.rstrip('/')}/api/characters/match",
            json={"text": query, "mode": mode},
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=30),
        ) as resp:
            data = await resp.json()
            latency_ms = int((asyncio.get_event_loop().time() - t_start) * 1000)
            if resp.status != 200:
                raise ValueError(f"API {resp.status}: {str(data)[:200]}")
            matches = data.get("matches", [])[:5]
            characters = [
                {
                    "id":     m["character"].get("id", ""),
                    "name":   m["character"]["name"],
                    "role":   m["character"].get("role", ""),
                    # matchedSkills = the skill names actually used in scoring
                    "skills": m.get("matchedSkills", [])[:10],
                }
                for m in matches
            ]
            return {"characters": characters, "latency_ms": latency_ms}

# ─── Background processing ───────────────────────────────────────────────────

async def process_run(
    run_id: str,
    queries: list,
    api_endpoint: str,
    matching_mode: str,
    judge_model: str,
    judge_api_key: str,
    concurrency: int,
    auth_header: Optional[str],
):
    sem = asyncio.Semaphore(concurrency)

    async def process_one(query: str):
        async with sem:
            now = datetime.utcnow().isoformat()
            try:
                match_result = await call_matching_api(query, api_endpoint, matching_mode, auth_header)
                characters = match_result["characters"]
                latency_ms = match_result["latency_ms"]

                if not characters:
                    raise ValueError("No matches returned from API")

                await asyncio.sleep(0.05)
                judgment = await judge_query(query, characters, judge_model, judge_api_key)

                scores = judgment.get("scores", [3] * 5)[:5]
                scores = [max(1, min(5, int(s))) for s in scores]
                quality = judgment.get("quality", 2)
                comment = judgment.get("comment", "")
                ndcg = ndcg_at_5(scores)

                db_write(
                    """INSERT INTO results
                       (run_id, query, top5_names, top5_roles, top5_ids, top5_skills,
                        individual_scores, ndcg5, ranking_quality, comment, latency_ms, created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        run_id, query,
                        json.dumps([c["name"]   for c in characters]),
                        json.dumps([c["role"]   for c in characters]),
                        json.dumps([c["id"]     for c in characters]),
                        json.dumps([c["skills"] for c in characters]),
                        json.dumps(scores),
                        ndcg, quality, comment, latency_ms, now,
                    ),
                )
                db_write(
                    "UPDATE runs SET completed_queries = completed_queries + 1 WHERE id = ?",
                    (run_id,),
                )
            except Exception as e:
                db_write(
                    "INSERT INTO results (run_id, query, error, created_at) VALUES (?,?,?,?)",
                    (run_id, query, str(e)[:500], now),
                )
                db_write(
                    "UPDATE runs SET failed_queries = failed_queries + 1 WHERE id = ?",
                    (run_id,),
                )

    db_write("UPDATE runs SET status = 'running' WHERE id = ?", (run_id,))
    await asyncio.gather(*[process_one(q) for q in queries])

    conn = sqlite3.connect(DB_PATH)
    row = conn.execute(
        "SELECT AVG(ndcg5) FROM results WHERE run_id = ? AND ndcg5 IS NOT NULL",
        (run_id,),
    ).fetchone()
    avg = row[0] if row and row[0] else None
    conn.execute(
        "UPDATE runs SET status = 'completed', avg_ndcg5 = ? WHERE id = ?",
        (avg, run_id),
    )
    conn.commit()
    conn.close()

# ─── FastAPI ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app):
    init_db()
    yield

app = FastAPI(lifespan=lifespan)


@app.post("/runs")
async def create_run(
    background_tasks: BackgroundTasks,
    name:          str           = Form(...),
    queries_text:  str           = Form(default=""),
    file:          Optional[UploadFile] = File(default=None),
    api_endpoint:  str           = Form(default="http://localhost:3000"),
    matching_mode: str           = Form(default="hybrid"),
    judge_model:   str           = Form(default="gemini-2.0-flash"),
    judge_api_key: str           = Form(...),
    concurrency:   int           = Form(default=5),
    auth_header:   str           = Form(default=""),
    notes:         str           = Form(default=""),
):
    queries: list[str] = []

    if file and file.filename:
        content = await file.read()
        text = content.decode("utf-8-sig")
        reader = csv.reader(io.StringIO(text))
        for row in reader:
            if row and row[0].strip():
                queries.append(row[0].strip())

    if queries_text.strip():
        for line in queries_text.splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                queries.append(line)

    seen: set[str] = set()
    queries = [q for q in queries if not (q in seen or seen.add(q))]  # type: ignore

    if not queries:
        return JSONResponse({"error": "クエリが1件もありません"}, status_code=400)

    run_id = str(uuid.uuid4())[:8]
    now = datetime.utcnow().isoformat()
    db_write(
        """INSERT INTO runs
           (id, name, created_at, status, total_queries,
            judge_model, api_endpoint, matching_mode, concurrency, notes)
           VALUES (?,?,?,'pending',?,?,?,?,?,?)""",
        (run_id, name, now, len(queries), judge_model,
         api_endpoint, matching_mode, concurrency, notes),
    )
    background_tasks.add_task(
        process_run, run_id, queries, api_endpoint, matching_mode,
        judge_model, judge_api_key, concurrency, auth_header or None,
    )
    return {"run_id": run_id, "total_queries": len(queries)}


@app.get("/runs")
async def list_runs():
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        """SELECT id, name, created_at, status, total_queries,
                  completed_queries, failed_queries, judge_model,
                  matching_mode, avg_ndcg5, notes
           FROM runs ORDER BY created_at DESC LIMIT 100"""
    ).fetchall()
    conn.close()
    return [
        {
            "id": r[0], "name": r[1], "created_at": r[2], "status": r[3],
            "total_queries": r[4], "completed_queries": r[5], "failed_queries": r[6],
            "judge_model": r[7], "matching_mode": r[8],
            "avg_ndcg5": round(r[9], 4) if r[9] else None,
            "notes": r[10],
        }
        for r in rows
    ]


@app.get("/runs/{run_id}")
async def get_run(run_id: str):
    conn = sqlite3.connect(DB_PATH)
    run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if not run:
        conn.close()
        return JSONResponse({"error": "Not found"}, status_code=404)
    results = conn.execute(
        """SELECT query, top5_names, top5_roles, top5_ids, top5_skills,
                  individual_scores, ndcg5, ranking_quality, comment, latency_ms, error
           FROM results WHERE run_id = ? ORDER BY id""",
        (run_id,),
    ).fetchall()
    conn.close()

    cols = ["id","name","created_at","status","total_queries","completed_queries",
            "failed_queries","judge_model","api_endpoint","matching_mode",
            "concurrency","avg_ndcg5","notes"]
    run_dict = dict(zip(cols, run))
    if run_dict["avg_ndcg5"]:
        run_dict["avg_ndcg5"] = round(run_dict["avg_ndcg5"], 4)

    return {
        "run": run_dict,
        "results": [
            {
                "query":    r[0],
                "top5":     json.loads(r[1]) if r[1] else [],
                "roles":    json.loads(r[2]) if r[2] else [],
                "ids":      json.loads(r[3]) if r[3] else [],
                "skills":   json.loads(r[4]) if r[4] else [],
                "scores":   json.loads(r[5]) if r[5] else [],
                "ndcg5":    round(r[6], 4) if r[6] else None,
                "quality":  r[7],
                "comment":  r[8],
                "latency_ms": r[9],
                "error":    r[10],
            }
            for r in results
        ],
    }


# ─── Fine-tuning export ──────────────────────────────────────────────────────

@app.get("/runs/{run_id}/finetune")
async def export_finetune(run_id: str, fmt: str = "triplets"):
    """
    fine-tuning 用データエクスポート

    ?fmt=triplets   (default) embedding 学習用 triplets JSONL
                    {"query": "...", "positive": "skill1 skill2...", "negative": "skillA skillB..."}

    ?fmt=labeled    flat labeled pairs JSONL
                    {"query": "...", "character": "name", "skills": "...", "score": 4, "relevant": true}

    ?fmt=preference DPO/RLHF スタイル
                    {"query": "...", "chosen": "name: skill1 skill2", "rejected": "name: skillA skillB"}
    """
    conn = sqlite3.connect(DB_PATH)
    run = conn.execute("SELECT name, status FROM runs WHERE id = ?", (run_id,)).fetchone()
    if not run:
        conn.close()
        return JSONResponse({"error": "Not found"}, status_code=404)

    rows = conn.execute(
        """SELECT query, top5_names, top5_roles, top5_skills, individual_scores
           FROM results
           WHERE run_id = ? AND ndcg5 IS NOT NULL AND error IS NULL
           ORDER BY id""",
        (run_id,),
    ).fetchall()
    conn.close()

    out = io.StringIO()

    if fmt == "labeled":
        # flat (query, character, skills, score, relevant)
        for r in rows:
            query  = r[0]
            names  = json.loads(r[1]) if r[1] else []
            roles  = json.loads(r[2]) if r[2] else []
            skills = json.loads(r[3]) if r[3] else []
            scores = json.loads(r[4]) if r[4] else []
            for i, (name, role, skill_list, score) in enumerate(zip(names, roles, skills, scores)):
                skill_text = " ".join(skill_list) if isinstance(skill_list, list) else str(skill_list)
                doc = f"{name}（{role}）: {skill_text}"
                out.write(json.dumps({
                    "query": query,
                    "character": name,
                    "role": role,
                    "skills": skill_text,
                    "document": doc,
                    "score": score,
                    "relevant": score >= 4,
                }, ensure_ascii=False) + "\n")

    elif fmt == "preference":
        # DPO pairs: highest scored vs lowest scored character per query
        for r in rows:
            query  = r[0]
            names  = json.loads(r[1]) if r[1] else []
            roles  = json.loads(r[2]) if r[2] else []
            skills = json.loads(r[3]) if r[3] else []
            scores = json.loads(r[4]) if r[4] else []
            if len(scores) < 2:
                continue
            indexed = list(zip(scores, names, roles, skills))
            best  = max(indexed, key=lambda x: x[0])
            worst = min(indexed, key=lambda x: x[0])
            if best[0] == worst[0]:
                continue  # skip if all same score
            def doc(name, role, skill_list):
                st = " ".join(skill_list) if isinstance(skill_list, list) else str(skill_list)
                return f"{name}（{role}）: {st}"
            out.write(json.dumps({
                "query":    query,
                "chosen":   doc(best[1],  best[2],  best[3]),
                "rejected": doc(worst[1], worst[2], worst[3]),
                "score_diff": best[0] - worst[0],
            }, ensure_ascii=False) + "\n")

    else:  # triplets (default)
        # embedding training: (query, positive_doc, negative_doc)
        # positive = score >= 4, negative = score <= 2
        for r in rows:
            query  = r[0]
            names  = json.loads(r[1]) if r[1] else []
            roles  = json.loads(r[2]) if r[2] else []
            skills = json.loads(r[3]) if r[3] else []
            scores = json.loads(r[4]) if r[4] else []

            positives = []
            negatives = []
            for name, role, skill_list, score in zip(names, roles, skills, scores):
                st = " ".join(skill_list) if isinstance(skill_list, list) else str(skill_list)
                doc = f"{name} {role} {st}"
                if score >= 4:
                    positives.append(doc)
                elif score <= 2:
                    negatives.append(doc)

            # Write one triplet per positive-negative pair
            for pos in positives:
                for neg in negatives:
                    out.write(json.dumps({
                        "query":    query,
                        "positive": pos,
                        "negative": neg,
                    }, ensure_ascii=False) + "\n")

            # If no negative in Top5, still emit positive-only (useful for contrastive loss)
            if positives and not negatives:
                for pos in positives:
                    out.write(json.dumps({
                        "query":    query,
                        "positive": pos,
                        "negative": None,
                    }, ensure_ascii=False) + "\n")

    content = out.getvalue()
    run_name = run[0].replace(" ", "_")[:30]
    return Response(
        content=content,
        media_type="application/x-ndjson",
        headers={"Content-Disposition": f"attachment; filename=finetune-{fmt}-{run_id}.jsonl"},
    )


# ─── Analysis ────────────────────────────────────────────────────────────────

@app.get("/runs/{run_id}/analysis")
async def get_analysis(run_id: str):
    """自動分析: 弱点パターン・改善提案"""
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        """SELECT query, top5_names, top5_roles, individual_scores, ndcg5
           FROM results
           WHERE run_id = ? AND error IS NULL
           ORDER BY ndcg5 ASC""",
        (run_id,),
    ).fetchall()
    conn.close()

    if not rows:
        return {"weak_queries": [], "character_failures": [], "suggestions": []}

    all_ndcg = [r[4] for r in rows if r[4] is not None]
    avg = sum(all_ndcg) / len(all_ndcg) if all_ndcg else 0

    # Weak queries (nDCG < 0.85)
    weak = [
        {
            "query":   r[0],
            "top1":    (json.loads(r[1]) if r[1] else ["—"])[0],
            "scores":  json.loads(r[3]) if r[3] else [],
            "ndcg5":   round(r[4], 3),
        }
        for r in rows if r[4] is not None and r[4] < 0.85
    ]

    # Characters that appear in weak queries with high rank but low score
    char_failure: dict[str, dict] = defaultdict(lambda: {"count": 0, "avg_score": 0, "scores": []})
    for r in rows:
        if r[4] is None or r[4] >= 0.85:
            continue
        names  = json.loads(r[1]) if r[1] else []
        scores = json.loads(r[3]) if r[3] else []
        for i, (name, score) in enumerate(zip(names, scores)):
            if i == 0 and score <= 2:  # Top1 が低スコア = 明確な誤り
                char_failure[name]["count"] += 1
                char_failure[name]["scores"].append(score)

    char_failures = []
    for name, data in sorted(char_failure.items(), key=lambda x: -x[1]["count"]):
        avg_score = sum(data["scores"]) / len(data["scores"])
        char_failures.append({
            "character": name,
            "top1_appearances_in_weak": data["count"],
            "avg_score_when_top1": round(avg_score, 2),
        })

    # Simple suggestions
    suggestions = []
    if len(weak) > 0:
        pct = len(weak) / len(all_ndcg) * 100
        suggestions.append(f"弱クエリが {len(weak)}件（{pct:.0f}%）あります。目標は0件。")

    if char_failures:
        top_offender = char_failures[0]["character"]
        suggestions.append(
            f"「{top_offender}」が誤って Top1 に来るケースが最多。"
            f"このキャラのスキル名が汎用的すぎる可能性があります。"
        )

    ndcg_vals = [r[4] for r in rows if r[4] is not None]
    very_bad = [v for v in ndcg_vals if v < 0.7]
    if very_bad:
        suggestions.append(
            f"nDCG@5 < 0.70 のクエリが {len(very_bad)}件。"
            f"これらは DB にそもそも対応キャラが存在しない可能性が高いです。"
        )

    good = [v for v in ndcg_vals if v >= 0.95]
    suggestions.append(
        f"nDCG@5 ≥ 0.95（優秀）: {len(good)}件 / {len(ndcg_vals)}件"
        f"（{len(good)/len(ndcg_vals)*100:.0f}%）"
    )

    return {
        "avg_ndcg5":         round(avg, 4),
        "total":             len(all_ndcg),
        "weak_count":        len(weak),
        "weak_queries":      weak[:30],
        "character_failures": char_failures[:10],
        "suggestions":       suggestions,
    }


@app.get("/runs/{run_id}/export")
async def export_csv(run_id: str):
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        """SELECT query, top5_names, top5_roles, individual_scores,
                  ndcg5, comment, latency_ms, error
           FROM results WHERE run_id = ? ORDER BY id""",
        (run_id,),
    ).fetchall()
    conn.close()

    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["query","top1","top2","top3","top4","top5",
                "score1","score2","score3","score4","score5",
                "ndcg5","comment","latency_ms","error"])
    for r in rows:
        names  = json.loads(r[1]) if r[1] else []
        scores = json.loads(r[3]) if r[3] else []
        w.writerow([
            r[0],
            *(names  + [""] * (5 - len(names))),
            *(scores + [""] * (5 - len(scores))),
            round(r[4], 4) if r[4] else "",
            r[5] or "", r[6] or "", r[7] or "",
        ])
    return Response(
        content=out.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=eval-{run_id}.csv"},
    )


# ─── Cross-run comparison ────────────────────────────────────────────────────

@app.get("/compare")
async def compare_runs(ids: str = ""):
    """複数runのnDCG@5を比較: ?ids=run1,run2,run3"""
    run_ids = [x.strip() for x in ids.split(",") if x.strip()]
    if not run_ids:
        return JSONResponse({"error": "ids parameter required"}, status_code=400)

    conn = sqlite3.connect(DB_PATH)
    result = []
    for rid in run_ids:
        run = conn.execute(
            "SELECT id, name, judge_model, matching_mode, avg_ndcg5, total_queries, completed_queries, notes FROM runs WHERE id = ?",
            (rid,),
        ).fetchone()
        if not run:
            continue
        dist = conn.execute(
            """SELECT
               SUM(CASE WHEN ndcg5 >= 0.95 THEN 1 ELSE 0 END),
               SUM(CASE WHEN ndcg5 >= 0.85 AND ndcg5 < 0.95 THEN 1 ELSE 0 END),
               SUM(CASE WHEN ndcg5 < 0.85 THEN 1 ELSE 0 END)
               FROM results WHERE run_id = ? AND ndcg5 IS NOT NULL""",
            (rid,),
        ).fetchone()
        result.append({
            "id": run[0], "name": run[1], "judge_model": run[2],
            "matching_mode": run[3],
            "avg_ndcg5": round(run[4], 4) if run[4] else None,
            "total": run[5], "completed": run[6], "notes": run[7],
            "dist": {"great": dist[0] or 0, "ok": dist[1] or 0, "bad": dist[2] or 0},
        })
    conn.close()
    return result


# ─── HTML ────────────────────────────────────────────────────────────────────

HTML = r"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>評価実験ラボ</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { font-family: 'SF Mono','Fira Code',monospace; }
  .tab-active   { background:#7c3aed; color:#fff; }
  .tab-inactive { background:#1f2937; color:#9ca3af; }
  .tab-inactive:hover { background:#374151; }
  .ndcg-great { color:#4ade80; }
  .ndcg-ok    { color:#facc15; }
  .ndcg-bad   { color:#f87171; }
  tr.rr:hover td { background:rgba(124,58,237,.07); }
  .input { width:100%; background:#1f2937; border:1px solid #374151; border-radius:.375rem; padding:.5rem .75rem; font-size:.875rem; color:#f3f4f6; outline:none; transition:border-color .15s; }
  .input:focus { border-color:#7c3aed; }
  .input:hover { border-color:#4b5563; }
  .lbl { display:block; font-size:.75rem; color:#9ca3af; margin-bottom:.25rem; font-weight:500; }
  .card { background:#111827; border:1px solid #1f2937; border-radius:.75rem; padding:.75rem; }
</style>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">
<div class="max-w-6xl mx-auto px-4 py-8">

  <div class="mb-6">
    <h1 class="text-2xl font-bold text-purple-400">🧪 マッチング評価実験ラボ</h1>
    <p class="text-gray-600 text-xs mt-1">CSV貼り付け → AI評価 → SQLite蓄積 → fine-tuningデータ生成</p>
  </div>

  <div class="flex gap-2 mb-6 border-b border-gray-800 pb-px">
    <button onclick="showTab('new')"      id="tab-new"      class="tab-active  px-4 py-2 rounded-t text-sm font-medium transition-colors">＋ 新規実験</button>
    <button onclick="showTab('history')"  id="tab-history"  class="tab-inactive px-4 py-2 rounded-t text-sm font-medium transition-colors">📋 履歴</button>
    <button onclick="showTab('compare')"  id="tab-compare"  class="tab-inactive px-4 py-2 rounded-t text-sm font-medium transition-colors">⚖️ 比較</button>
  </div>

  <!-- ═══ NEW ════════════════════════════════════════════════════════════════ -->
  <div id="pane-new">
    <form id="run-form">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="space-y-4">
          <div><label class="lbl">実験名</label>
            <input name="name" type="text" required placeholder="例: セールス領域テスト #1" class="input"></div>

          <div><label class="lbl">クエリ（1行1件 / #コメント行はスキップ）</label>
            <textarea name="queries_text" id="qt" rows="12"
              placeholder="# セールス系クエリ&#10;インサイドセールスのKPIを設計したい&#10;SalesforceとHubSpotを連携させる方法&#10;大企業の稟議プロセスを攻略したい&#10;..."
              class="input resize-y"></textarea>
            <p class="text-xs text-gray-700 mt-1">テキスト貼り付け + CSV同時も可（重複自動除外）</p></div>

          <div><label class="lbl">CSVアップロード（1列目がクエリ）</label>
            <input name="file" type="file" accept=".csv,.txt"
              class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-400
                     file:bg-purple-700 file:text-white file:border-0 file:rounded file:px-3 file:py-1
                     file:mr-3 file:text-xs cursor-pointer"></div>

          <div><label class="lbl">メモ（任意）</label>
            <input name="notes" type="text" placeholder="例: 語彙シードv2 vs v1" class="input"></div>
        </div>

        <div class="space-y-4">
          <div><label class="lbl">マッチングAPIエンドポイント</label>
            <input name="api_endpoint" type="text" value="http://localhost:3000" class="input"></div>

          <div><label class="lbl">Authorization ヘッダー（任意）</label>
            <input name="auth_header" type="text" placeholder="Bearer eyJ... （不要なら空白）" class="input"></div>

          <div><label class="lbl">マッチングモード</label>
            <select name="matching_mode" class="input">
              <option value="hybrid" selected>hybrid（BM25 + Embedding + RRF）</option>
              <option value="bm25">bm25（キーワードのみ）</option>
              <option value="semantic">semantic（ベクトルのみ）</option>
            </select></div>

          <div><label class="lbl">評価LLMモデル</label>
            <select name="judge_model" id="jm" class="input" onchange="onMC()">
              <optgroup label="── Gemini（推奨・無料枠あり）">
                <option value="gemini-2.0-flash" selected>gemini-2.0-flash ⚡ 1500req/分 無料</option>
                <option value="gemini-2.5-flash-preview-05-20">gemini-2.5-flash-preview 🧠 高品質</option>
                <option value="gemini-1.5-flash">gemini-1.5-flash</option>
                <option value="gemini-1.5-pro">gemini-1.5-pro 💎 最高品質</option>
              </optgroup>
              <optgroup label="── OpenAI">
                <option value="gpt-4o-mini">gpt-4o-mini</option>
                <option value="gpt-4o">gpt-4o</option>
              </optgroup>
            </select></div>

          <div><label class="lbl" id="akl">Gemini APIキー</label>
            <input name="judge_api_key" type="password" required placeholder="AIza..." class="input">
            <p class="text-xs text-gray-700 mt-1">
              <a href="https://aistudio.google.com/apikey" target="_blank" class="text-purple-400 hover:underline">Google AI Studio でキー取得</a>
            </p></div>

          <div><label class="lbl">並列数</label>
            <select name="concurrency" class="input">
              <option value="3">3（低負荷）</option>
              <option value="5" selected>5（推奨）</option>
              <option value="10">10（Gemini Flash向け）</option>
              <option value="20">20（大量処理・1000件+）</option>
            </select></div>

          <div class="card text-xs text-gray-500 space-y-1">
            <div class="text-gray-400 font-semibold">📊 コスト・時間見積もり</div>
            <div id="est">クエリを入力すると表示されます</div>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-4 pt-5">
        <button type="submit" id="sbtn"
          class="bg-purple-600 hover:bg-purple-700 text-white px-8 py-3 rounded font-semibold text-sm transition-colors">
          🚀 実験開始
        </button>
        <span id="smsg" class="text-sm"></span>
      </div>
    </form>

    <div id="pgcard" class="hidden mt-6 bg-gray-900 rounded-xl p-5 border border-purple-800">
      <div class="flex items-center justify-between mb-3">
        <div>
          <span class="text-purple-300 font-semibold" id="pgname">—</span>
          <span class="text-gray-600 text-xs ml-2" id="pgid"></span>
        </div>
        <span id="pgst" class="text-xs bg-yellow-900 text-yellow-300 px-2 py-0.5 rounded">実行中…</span>
      </div>
      <div class="w-full bg-gray-800 rounded-full h-2.5 mb-2">
        <div id="pgbar" class="bg-purple-500 h-2.5 rounded-full transition-all duration-500" style="width:0%"></div>
      </div>
      <div class="flex justify-between text-xs text-gray-500">
        <span id="pgcnt">0 / 0 件</span>
        <span id="pgndcg" class="text-purple-400 font-bold"></span>
      </div>
    </div>
  </div>

  <!-- ═══ HISTORY ═══════════════════════════════════════════════════════════ -->
  <div id="pane-history" class="hidden">
    <div class="flex justify-between items-center mb-4">
      <h2 class="text-sm font-medium text-gray-400">実験一覧（最新100件）</h2>
      <button onclick="loadHistory()" class="text-xs text-purple-400 bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded">🔄 更新</button>
    </div>
    <div id="rlist" class="space-y-2"><p class="text-gray-600 text-sm">読み込み中…</p></div>

    <div id="rdetail" class="hidden mt-8">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-sm font-semibold text-gray-200" id="dname"></h3>
        <div class="flex gap-2 flex-wrap">
          <a id="exp-csv"     href="#" class="btn-sm">⬇ CSV</a>
          <a id="exp-triplet" href="#" class="btn-sm text-green-400 border-green-800 hover:bg-green-900">🧬 Triplets JSONL</a>
          <a id="exp-labeled" href="#" class="btn-sm text-blue-400 border-blue-800 hover:bg-blue-900">📊 Labeled JSONL</a>
          <a id="exp-pref"    href="#" class="btn-sm text-yellow-400 border-yellow-800 hover:bg-yellow-900">⚖️ Preference JSONL</a>
          <button id="btn-analysis" onclick="loadAnalysis()" class="btn-sm text-purple-400 border-purple-800 hover:bg-purple-900">🔍 分析</button>
          <button onclick="closeDetail()" class="btn-sm">✕ 閉じる</button>
        </div>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <div class="card"><div class="text-xs text-gray-500">nDCG@5 平均</div><div class="text-2xl font-bold" id="sn">—</div></div>
        <div class="card"><div class="text-xs text-gray-500">処理件数</div><div class="text-2xl font-bold text-gray-200" id="sc">—</div></div>
        <div class="card"><div class="text-xs text-gray-500">エラー</div><div class="text-2xl font-bold text-red-400" id="se">—</div></div>
        <div class="card"><div class="text-xs text-gray-500">評価モデル</div><div class="text-xs text-gray-300 truncate mt-1" id="sm">—</div></div>
        <div class="card"><div class="text-xs text-gray-500">モード</div><div class="text-sm text-gray-300 mt-1" id="smode">—</div></div>
      </div>

      <div class="mb-4">
        <div class="text-xs text-gray-500 mb-1">nDCG@5 分布</div>
        <div class="flex h-4 rounded overflow-hidden gap-px">
          <div id="dgreat" class="bg-green-600 flex items-center justify-center text-white text-xs" style="width:0%"></div>
          <div id="dok"    class="bg-yellow-600 flex items-center justify-center text-white text-xs" style="width:0%"></div>
          <div id="dbad"   class="bg-red-700 flex items-center justify-center text-white text-xs"   style="width:0%"></div>
        </div>
        <div class="flex gap-4 mt-1 text-xs text-gray-600">
          <span><span class="text-green-400">■</span> ≥0.95: <span id="cgreat">0</span>件</span>
          <span><span class="text-yellow-400">■</span> 0.85-0.95: <span id="cok">0</span>件</span>
          <span><span class="text-red-400">■</span> &lt;0.85: <span id="cbad">0</span>件</span>
        </div>
      </div>

      <!-- Analysis panel (hidden until clicked) -->
      <div id="analysis-panel" class="hidden mb-4 bg-gray-900 rounded-xl p-4 border border-purple-900">
        <h4 class="text-sm font-semibold text-purple-400 mb-3">🔍 自動分析レポート</h4>
        <div id="analysis-content" class="text-xs text-gray-400 space-y-2">読み込み中…</div>
      </div>

      <div class="overflow-x-auto rounded-lg border border-gray-800">
        <table class="w-full text-xs">
          <thead class="bg-gray-900 text-gray-500">
            <tr>
              <th class="text-left py-2 px-3 w-8">#</th>
              <th class="text-left py-2 px-3">クエリ</th>
              <th class="text-left py-2 px-3">Top1</th>
              <th class="text-left py-2 px-3">Top2</th>
              <th class="text-left py-2 px-3">Top3</th>
              <th class="text-center py-2 px-3">スコア</th>
              <th class="text-center py-2 px-3 w-16">nDCG@5</th>
              <th class="text-left py-2 px-3">コメント</th>
            </tr>
          </thead>
          <tbody id="rtbody" class="divide-y divide-gray-900 bg-gray-950"></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- ═══ COMPARE ════════════════════════════════════════════════════════════ -->
  <div id="pane-compare" class="hidden">
    <div class="mb-4">
      <label class="lbl">比較するRun ID（カンマ区切り）</label>
      <div class="flex gap-2">
        <input id="cmp-ids" type="text" placeholder="例: a1b2c3d4, e5f6g7h8" class="input">
        <button onclick="loadCompare()" class="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded text-sm whitespace-nowrap">比較</button>
      </div>
    </div>
    <div id="cmp-result"></div>
  </div>

</div>

<style>
  .btn-sm { display:inline-block; font-size:.7rem; background:#1f2937; border:1px solid #374151; border-radius:.375rem; padding:.25rem .75rem; color:#9ca3af; cursor:pointer; transition:background .15s; }
  .btn-sm:hover { background:#374151; }
</style>

<script>
let pollTimer = null;
let curRunId = null;

function showTab(t) {
  ['new','history','compare'].forEach(id => {
    document.getElementById('pane-'+id).classList.toggle('hidden', id !== t);
    document.getElementById('tab-'+id).className =
      (id===t ? 'tab-active' : 'tab-inactive') + ' px-4 py-2 rounded-t text-sm font-medium transition-colors';
  });
  if (t === 'history') loadHistory();
}

function onMC() {
  const m = document.getElementById('jm').value;
  const isOAI = m.startsWith('gpt-') || m.startsWith('o');
  document.getElementById('akl').textContent = isOAI ? 'OpenAI APIキー' : 'Gemini APIキー';
  updateEst();
}
function updateEst() {
  const n = document.getElementById('qt').value.split('\n').filter(l=>l.trim()&&!l.startsWith('#')).length;
  const m = document.getElementById('jm').value;
  const c = parseInt(document.querySelector('select[name=concurrency]')?.value||'5');
  if (!n) { document.getElementById('est').textContent='クエリを入力すると表示されます'; return; }
  let cost = m.startsWith('gemini-2.0-flash')||m.includes('1.5-flash')
    ? '約 $0（無料枠）'
    : m.includes('pro')||m.includes('2.5') ? `約 $${(n*.0005).toFixed(3)}`
    : m==='gpt-4o-mini' ? `約 $${(n*.00015).toFixed(4)}`
    : `約 $${(n*.01).toFixed(2)}`;
  const s = Math.ceil(n/c)*2;
  document.getElementById('est').innerHTML = `${n}件 ／ ${cost}<br>約${s}秒（${Math.ceil(s/60)}分）@ 並列${c}`;
}
document.getElementById('qt').addEventListener('input', updateEst);
document.getElementById('jm').addEventListener('change', updateEst);

document.getElementById('run-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('sbtn');
  const msg = document.getElementById('smsg');
  btn.disabled=true; btn.textContent='送信中…'; msg.textContent=''; msg.className='text-sm';
  try {
    const fd = new FormData(e.target);
    const r = await fetch('/runs', {method:'POST', body:fd});
    const d = await r.json();
    if (d.error) { msg.textContent='❌ '+d.error; msg.className='text-sm text-red-400'; return; }
    msg.textContent=`✅ 実験開始 — ${d.total_queries}件をキューに投入`;
    msg.className='text-sm text-green-400';
    document.getElementById('pgcard').classList.remove('hidden');
    document.getElementById('pgname').textContent = fd.get('name');
    document.getElementById('pgid').textContent = '#'+d.run_id;
    startPoll(d.run_id, d.total_queries);
  } catch(err) {
    msg.textContent='❌ '+err.message; msg.className='text-sm text-red-400';
  } finally { btn.disabled=false; btn.textContent='🚀 実験開始'; }
});

function startPoll(rid, total) {
  if (pollTimer) clearInterval(pollTimer);
  curRunId = rid;
  const poll = async () => {
    try {
      const d = (await (await fetch(`/runs/${rid}`)).json()).run;
      const p = total>0 ? d.completed_queries/total*100 : 0;
      document.getElementById('pgbar').style.width=p+'%';
      document.getElementById('pgcnt').textContent=
        `${d.completed_queries} / ${total} 件${d.failed_queries>0?` (エラー: ${d.failed_queries})`:''}`;
      if (d.avg_ndcg5) document.getElementById('pgndcg').textContent=`nDCG@5: ${d.avg_ndcg5.toFixed(4)}`;
      if (d.status==='completed'||d.status==='failed') {
        clearInterval(pollTimer);
        const ok = d.status==='completed';
        document.getElementById('pgst').textContent = ok?'完了 ✅':'失敗 ❌';
        document.getElementById('pgst').className =
          `text-xs px-2 py-0.5 rounded ${ok?'bg-green-900 text-green-300':'bg-red-900 text-red-300'}`;
      }
    } catch {}
  };
  poll(); pollTimer = setInterval(poll, 3000);
}

async function loadHistory() {
  const runs = await (await fetch('/runs')).json();
  const el = document.getElementById('rlist');
  if (!runs.length) { el.innerHTML='<p class="text-gray-600 text-sm">実験履歴がありません</p>'; return; }
  const sc = {completed:'bg-green-900 text-green-300',running:'bg-yellow-900 text-yellow-300',
               pending:'bg-gray-800 text-gray-400',failed:'bg-red-900 text-red-300'};
  el.innerHTML = runs.map(r => {
    const nc = !r.avg_ndcg5?'text-gray-600':r.avg_ndcg5>=0.93?'text-green-400':r.avg_ndcg5>=0.88?'text-yellow-400':'text-red-400';
    return `<div class="card hover:border-gray-600 cursor-pointer transition-colors" onclick="loadDetail('${r.id}')">
      <div class="flex flex-wrap items-center gap-2 mb-1">
        <span class="text-xs px-1.5 py-0.5 rounded ${sc[r.status]||sc.pending}">${r.status}</span>
        <span class="text-sm font-semibold text-gray-200">${esc(r.name)}</span>
        <span class="text-xs text-gray-600">#${r.id}</span>
        <span class="ml-auto ${nc} font-bold">${r.avg_ndcg5?r.avg_ndcg5.toFixed(4):'—'}</span>
      </div>
      <div class="flex flex-wrap gap-3 text-xs text-gray-600">
        <span>${r.matching_mode}</span><span>${r.judge_model}</span>
        <span>${r.completed_queries}/${r.total_queries}件</span>
        <span>${r.created_at.slice(0,16).replace('T',' ')} UTC</span>
        ${r.notes?`<span class="text-gray-500">${esc(r.notes)}</span>`:''}
      </div></div>`;
  }).join('');
}

async function loadDetail(rid) {
  const {run, results} = await (await fetch(`/runs/${rid}`)).json();
  curRunId = rid;
  document.getElementById('rdetail').classList.remove('hidden');
  document.getElementById('analysis-panel').classList.add('hidden');
  document.getElementById('dname').textContent = run.name;
  document.getElementById('exp-csv').href     = `/runs/${rid}/export`;
  document.getElementById('exp-triplet').href = `/runs/${rid}/finetune?fmt=triplets`;
  document.getElementById('exp-labeled').href = `/runs/${rid}/finetune?fmt=labeled`;
  document.getElementById('exp-pref').href    = `/runs/${rid}/finetune?fmt=preference`;

  const nc = !run.avg_ndcg5?'text-purple-400':run.avg_ndcg5>=0.93?'text-green-400':run.avg_ndcg5>=0.88?'text-yellow-400':'text-red-400';
  document.getElementById('sn').textContent = run.avg_ndcg5?run.avg_ndcg5.toFixed(4):'—';
  document.getElementById('sn').className   = `text-2xl font-bold ${nc}`;
  document.getElementById('sc').textContent = `${run.completed_queries}/${run.total_queries}`;
  document.getElementById('se').textContent = run.failed_queries||0;
  document.getElementById('sm').textContent = run.judge_model;
  document.getElementById('smode').textContent = run.matching_mode;

  const valid = results.filter(r=>r.ndcg5!=null);
  const great = valid.filter(r=>r.ndcg5>=0.95).length;
  const ok    = valid.filter(r=>r.ndcg5>=0.85&&r.ndcg5<0.95).length;
  const bad   = valid.filter(r=>r.ndcg5<0.85).length;
  const tot   = valid.length||1;
  document.getElementById('dgreat').style.width=(great/tot*100)+'%';
  document.getElementById('dok').style.width=(ok/tot*100)+'%';
  document.getElementById('dbad').style.width=(bad/tot*100)+'%';
  document.getElementById('cgreat').textContent=great;
  document.getElementById('cok').textContent=ok;
  document.getElementById('cbad').textContent=bad;

  document.getElementById('rtbody').innerHTML = results.map((r,i)=>{
    if (r.error) return `<tr class="rr"><td class="py-1.5 px-3 text-gray-600">${i+1}</td>
      <td class="py-1.5 px-3 text-gray-400" title="${esc(r.query)}">${esc(r.query.slice(0,50))}</td>
      <td colspan="5" class="py-1.5 px-3 text-red-500">${esc(r.error)}</td></tr>`;
    const nc2=!r.ndcg5?'text-gray-500':r.ndcg5>=0.95?'ndcg-great':r.ndcg5>=0.85?'ndcg-ok':'ndcg-bad';
    const tops=r.top5||[];
    return `<tr class="rr">
      <td class="py-1.5 px-3 text-gray-600">${i+1}</td>
      <td class="py-1.5 px-3 text-gray-300 max-w-[180px]"><div class="truncate" title="${esc(r.query)}">${esc(r.query.slice(0,55))}${r.query.length>55?'…':''}</div></td>
      <td class="py-1.5 px-3 text-blue-400 whitespace-nowrap">${esc(tops[0]||'—')}</td>
      <td class="py-1.5 px-3 text-gray-500 whitespace-nowrap">${esc(tops[1]||'—')}</td>
      <td class="py-1.5 px-3 text-gray-600 whitespace-nowrap">${esc(tops[2]||'—')}</td>
      <td class="py-1.5 px-3 text-center text-gray-500 whitespace-nowrap">[${(r.scores||[]).join(',')}]</td>
      <td class="py-1.5 px-3 text-center font-bold whitespace-nowrap ${nc2}">${r.ndcg5?r.ndcg5.toFixed(3):'—'}</td>
      <td class="py-1.5 px-3 text-gray-600 max-w-[150px] truncate" title="${esc(r.comment||'')}">${esc((r.comment||'').slice(0,50))}</td>
    </tr>`;
  }).join('');
  document.getElementById('rdetail').scrollIntoView({behavior:'smooth'});
}

async function loadAnalysis() {
  const panel = document.getElementById('analysis-panel');
  const content = document.getElementById('analysis-content');
  panel.classList.remove('hidden');
  content.innerHTML = '読み込み中…';
  try {
    const d = await (await fetch(`/runs/${curRunId}/analysis`)).json();
    let html = '';
    // Suggestions
    html += '<div class="space-y-1 mb-3">';
    d.suggestions.forEach(s => { html += `<div class="text-gray-300">• ${esc(s)}</div>`; });
    html += '</div>';
    // Weak queries
    if (d.weak_queries.length) {
      html += `<div class="text-yellow-400 font-medium mb-2">⚠️ 弱クエリ（nDCG@5 &lt; 0.85）: ${d.weak_count}件</div>`;
      html += '<div class="overflow-x-auto"><table class="w-full text-xs mb-3"><thead class="text-gray-500"><tr><th class="text-left py-1 pr-3">クエリ</th><th class="text-left py-1 pr-3">Top1</th><th class="text-center py-1 pr-3">スコア</th><th class="text-center py-1">nDCG@5</th></tr></thead><tbody class="divide-y divide-gray-800">';
      d.weak_queries.forEach(w => {
        const nc = w.ndcg5>=0.7?'ndcg-ok':'ndcg-bad';
        html += `<tr><td class="py-1 pr-3 text-gray-300">${esc(w.query.slice(0,60))}</td><td class="py-1 pr-3 text-blue-400">${esc(w.top1)}</td><td class="py-1 pr-3 text-center text-gray-500">[${(w.scores||[]).join(',')}]</td><td class="py-1 text-center font-bold ${nc}">${w.ndcg5}</td></tr>`;
      });
      html += '</tbody></table></div>';
    }
    // Character failures
    if (d.character_failures.length) {
      html += '<div class="text-red-400 font-medium mb-2">🎯 Top1 に誤って来るキャラクター</div>';
      html += '<div class="space-y-1">';
      d.character_failures.forEach(cf => {
        html += `<div class="flex justify-between text-gray-400"><span>「${esc(cf.character)}」</span><span class="text-gray-600">${cf.top1_appearances_in_weak}件 / 平均スコア ${cf.avg_score_when_top1}</span></div>`;
      });
      html += '</div>';
    }
    content.innerHTML = html;
  } catch(e) {
    content.innerHTML = `<span class="text-red-400">エラー: ${esc(e.message)}</span>`;
  }
}

function closeDetail() { document.getElementById('rdetail').classList.add('hidden'); }

async function loadCompare() {
  const ids = document.getElementById('cmp-ids').value;
  if (!ids.trim()) return;
  const data = await (await fetch(`/compare?ids=${encodeURIComponent(ids)}`)).json();
  const el = document.getElementById('cmp-result');
  if (!data.length) { el.innerHTML='<p class="text-gray-600 text-sm">データなし</p>'; return; }
  // Sort by avg_ndcg5 desc
  data.sort((a,b) => (b.avg_ndcg5||0)-(a.avg_ndcg5||0));
  const best = data[0].avg_ndcg5||0;
  el.innerHTML = `<div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-gray-500 border-b border-gray-800"><tr>
    <th class="text-left py-2 pr-4">実験名</th>
    <th class="text-center py-2 pr-4">nDCG@5</th>
    <th class="text-center py-2 pr-4">差分</th>
    <th class="text-left py-2 pr-4">モード</th>
    <th class="text-left py-2 pr-4">評価モデル</th>
    <th class="text-left py-2">分布 (✅/🟡/❌)</th>
  </tr></thead><tbody class="divide-y divide-gray-900">` +
  data.map(r => {
    const nc = !r.avg_ndcg5?'text-gray-600':r.avg_ndcg5>=0.93?'text-green-400':r.avg_ndcg5>=0.88?'text-yellow-400':'text-red-400';
    const diff = r.avg_ndcg5 ? (r.avg_ndcg5 - best) : null;
    const diffStr = diff === null ? '—' : diff === 0 ? '🏆' : `${(diff*100).toFixed(2)}%`;
    const {great,ok,bad} = r.dist;
    return `<tr><td class="py-2 pr-4 text-gray-200">${esc(r.name)}<br><span class="text-xs text-gray-600">#${r.id} ${r.notes?'— '+esc(r.notes):''}</span></td>
      <td class="py-2 pr-4 text-center font-bold ${nc}">${r.avg_ndcg5?.toFixed(4)||'—'}</td>
      <td class="py-2 pr-4 text-center text-gray-400">${diffStr}</td>
      <td class="py-2 pr-4 text-gray-500">${r.matching_mode}</td>
      <td class="py-2 pr-4 text-gray-500">${r.judge_model}</td>
      <td class="py-2 text-xs text-gray-500"><span class="text-green-400">${great}</span> / <span class="text-yellow-400">${ok}</span> / <span class="text-red-400">${bad}</span></td>
    </tr>`;
  }).join('') + '</tbody></table></div>';
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
</script>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
async def root():
    return HTML


if __name__ == "__main__":
    import uvicorn
    print("\n🧪 評価実験ラボ起動中...")
    print("   http://localhost:8100 をブラウザで開いてください\n")
    uvicorn.run("app:app", host="0.0.0.0", port=8100, reload=True)
