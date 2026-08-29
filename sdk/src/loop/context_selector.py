#!/usr/bin/env python3
"""Decide what context the composer sees for one subtask round.

The harness runs this script before every composer episode and shows its
output to the operator (state/context/<subtask>-r<N>.json), so the selection
must be deterministic and explainable: every section carries a `reason`.

Input (JSON on stdin):
  {
    "state_dir": "...", "workspace": "...", "memory_dir": "...",
    "subtask_id": "...", "round": 1,
    "plan": {...plan.json...},
    "max_chars": 60000
  }

Output (JSON on stdout):
  {"sections": [{"title", "kind", "path", "text", "reason", "chars"}], "dropped": [...]}

Selection rules, in priority order (higher first; sections are appended until
the character budget is spent, and each section is individually bounded):
  1. the subtask's own previous progress note and the latest evaluation
     (round > 1): the composer must fix what the evaluator found;
  2. progress notes of the leaves this subtask depends on;
  3. progress notes of the two most recently finished sibling leaves;
  4. memory pages whose name/description/tags overlap the subtask's words;
  5. planner research notes whose title overlaps the subtask's words.
"""
import json
import os
import re
import sys

STOP = set("""a an the and or of to in on for with by from as at is are be this that it its into
your you we our their them they will can should must not no yes via per each all any
create make build write add use using set get put run""".split())


def words(text):
    return {w for w in re.findall(r"[a-zA-Z0-9çğıöşüÇĞİÖŞÜ]{3,}", (text or "").lower()) if w not in STOP}


def read(path, limit):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read(limit + 1)
    except OSError:
        return None
    if len(text) > limit:
        text = text[:limit] + "\n[truncated by the context selector]"
    return text


def walk(nodes, parent=None):
    for node in nodes:
        yield node, parent
        yield from walk(node.get("children") or [], node)


def frontmatter(text):
    meta = {}
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end > 0:
            for line in text[3:end].splitlines():
                m = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$", line.strip())
                if m:
                    meta[m.group(1)] = m.group(2).strip().strip("\"'")
    return meta


def main():
    payload = json.load(sys.stdin)
    state = payload["state_dir"]
    memory_dir = payload.get("memory_dir") or ""
    subtask_id = payload["subtask_id"]
    rnd = int(payload.get("round") or 1)
    plan = payload.get("plan") or {}
    budget = int(payload.get("max_chars") or 60000)

    nodes = list(walk(plan.get("nodes") or []))
    by_id = {n["id"]: n for n, _ in nodes}
    leaves = [n for n, _ in nodes if not (n.get("children") or [])]
    me = by_id.get(subtask_id) or {}
    parent = next((p for n, p in nodes if n.get("id") == subtask_id), None)
    keywords = words(" ".join([me.get("title", ""), me.get("goal", ""), " ".join(me.get("deliverables") or []),
                               " ".join(me.get("acceptance") or [])]))

    candidates = []  # (priority, title, kind, path, limit, reason)

    if rnd > 1:
        prog = os.path.join(state, "progress", f"{subtask_id}.md")
        candidates.append((100, f"Your previous progress note (round {rnd - 1})", "progress", prog, 12000,
                           "same subtask, earlier round: do not redo finished work"))
        eval_dir = os.path.join(state, "evaluations", subtask_id)
        latest = None
        if os.path.isdir(eval_dir):
            files = sorted(f for f in os.listdir(eval_dir) if re.match(r"r\d+\.md$", f))
            if files:
                latest = os.path.join(eval_dir, files[-1])
        if latest:
            candidates.append((99, "Latest evaluation of this subtask (fix these findings first)", "evaluation",
                               latest, 16000, "the evaluator's verdict decides whether the subtask closes"))

    for dep in me.get("depends_on") or []:
        prog = os.path.join(state, "progress", f"{dep}.md")
        candidates.append((80, f"Progress note of dependency `{dep}`", "progress", prog, 8000,
                           "this subtask declares a dependency on it"))

    siblings = [n for n in (parent.get("children") if parent else plan.get("nodes") or [])
                if not (n.get("children") or []) and n.get("id") != subtask_id and n.get("status") == "done"]
    for sib in siblings[-2:]:
        prog = os.path.join(state, "progress", f"{sib['id']}.md")
        candidates.append((60, f"Progress note of finished sibling `{sib['id']}`", "progress", prog, 6000,
                           "recently finished neighbour in the same branch; likely shares files and conventions"))

    scored = []
    if memory_dir and os.path.isdir(memory_dir):
        for name in sorted(os.listdir(memory_dir)):
            if not name.endswith(".md") or name in ("index.md", "log.md"):
                continue
            path = os.path.join(memory_dir, name)
            head = read(path, 4000) or ""
            meta = frontmatter(head)
            hay = words(" ".join([name, meta.get("name", ""), meta.get("description", ""), meta.get("tags", ""), head[:1500]]))
            overlap = len(keywords & hay)
            if overlap:
                scored.append((overlap, name, path))
    scored.sort(key=lambda t: (-t[0], t[1]))
    for overlap, name, path in scored[:5]:
        candidates.append((40 + min(overlap, 9), f"Memory page {name}", "memory", path, 6000,
                           f"{overlap} keyword(s) shared with this subtask"))

    research_dir = os.path.join(state, "research")
    rscored = []
    if os.path.isdir(research_dir):
        for name in sorted(os.listdir(research_dir)):
            if not name.endswith(".md"):
                continue
            path = os.path.join(research_dir, name)
            head = read(path, 2500) or ""
            overlap = len(keywords & words(name + " " + head))
            if overlap:
                rscored.append((overlap, name, path))
    rscored.sort(key=lambda t: (-t[0], t[1]))
    for overlap, name, path in rscored[:3]:
        candidates.append((30 + min(overlap, 9), f"Planner research note {name}", "research", path, 8000,
                           f"{overlap} keyword(s) shared with this subtask"))

    candidates.sort(key=lambda c: -c[0])
    sections, dropped, used = [], [], 0
    for prio, title, kind, path, limit, reason in candidates:
        text = read(path, limit)
        if text is None or not text.strip():
            dropped.append({"title": title, "path": path, "reason": "missing or empty"})
            continue
        if used + len(text) > budget:
            dropped.append({"title": title, "path": path, "reason": "character budget exhausted"})
            continue
        used += len(text)
        sections.append({"title": title, "kind": kind, "path": path, "text": text, "reason": reason, "chars": len(text)})

    json.dump({"sections": sections, "dropped": dropped, "keywords": sorted(keywords)[:40], "chars": used},
              sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
