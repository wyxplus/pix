"""Load only the pinned upstream prompt function; do not execute its API runner/imports."""
import ast
import hashlib
import json
import sys

source_path, expected_sha, payload_path = sys.argv[1:]
source = open(source_path, "rb").read()
if hashlib.sha256(source).hexdigest() != expected_sha:
    raise ValueError("official_judge_source_hash_mismatch")
tree = ast.parse(source)
functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "get_anscheck_prompt"]
if len(functions) != 1:
    raise ValueError("official_judge_prompt_function_missing")
scope = {"__builtins__": {"NotImplementedError": NotImplementedError}}
exec(compile(ast.Module(body=functions, type_ignores=[]), source_path, "exec"), scope)
rows = json.load(open(payload_path))
for row in rows:
    row["prompt"] = scope["get_anscheck_prompt"](
        row["question_type"], row["question"], row["answer"], row["hypothesis"],
        abstention="_abs" in row["question_id"],
    )
print(json.dumps(rows, ensure_ascii=False))
