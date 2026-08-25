#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
Transcribes reviewer feedback (text and audio) for one material under review and
produces:

  1. A markdown report grouped by section, for a human to read.
  2. Optionally (--json <path>), a structured list for the correction engine.

Flow:

  1. Fetches the feedback through the read function, which returns signed URLs
     for any audio.
  2. For each item with audio, downloads it to a temporary file and transcribes it.
  3. Groups by section and writes the markdown (and the JSON, if requested).

NOTE ON PLACEHOLDERS: the tokens in double braces appear ONLY in the constants
below, never in this docstring. Substitution is a plain text replacement across
the whole file, and a Windows path injected into a normal string would become an
invalid escape sequence and break compilation. That is also why this docstring is
a raw string.

Filters (applied client-side, so this works even against a server function that
does not filter):

  --project <name>     only feedback whose project matches (case-insensitive)
  --material <name>    only feedback whose material matches (case-insensitive)
  --reviewer <name>    only feedback from that reviewer
  --json <path>        also write the structured list to this path
  --md <path>          override the default markdown output path

Secrets:

  - Dashboard password: first positional argument, or the FEEDBACK_PASSWORD
    environment variable.
  - Transcription API key: from the environment first; if absent, read from a
    local env file. Never hardcoded, never logged.

Temporary audio files are ALWAYS removed, including on error.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from collections import defaultdict

# ---------------------------------------------------------------------------
# PLACEHOLDERS: replaced by the skill when the template is instantiated
# ---------------------------------------------------------------------------
EDGE_FN_URL    = "{{EDGE_FN_URL}}"
OUT_MD_DEFAULT = r"{{OUT_MD_DEFAULT}}"

GROQ_MODEL        = "whisper-large-v3"
GROQ_ENV_FALLBACK = r"<your-env-file>"


def check_template_was_filled_in():
    """Stop with a clear message if the template was copied without filling it in."""
    if "{{" in EDGE_FN_URL or "{{" in OUT_MD_DEFAULT:
        sys.exit(
            "Error: this file is still a TEMPLATE (placeholders not "
            "replaced). Instantiate it through the collaborative-review skill first."
        )


def parse_args():
    p = argparse.ArgumentParser(
        description="Transcribes feedback (text and audio) into markdown grouped by section "
                    "(plus optional JSON for the correction engine)."
    )
    p.add_argument("password", nargs="?", default=None,
                   help="dashboard password (or use the FEEDBACK_PASSWORD variable)")
    p.add_argument("--project", default=None,
                   help="filter by project (case-insensitive)")
    p.add_argument("--material", default=None,
                   help="filter by material (case-insensitive)")
    p.add_argument("--reviewer", default=None,
                   help="filter by reviewer name (case-insensitive)")
    p.add_argument("--include-legacy", action="store_true", dest="include_legacy",
                   help="include legacy rows (no project/material) even when "
                        "filtro de project_name/material ativo")
    p.add_argument("--json", default=None, dest="json_path", metavar="CAMINHO",
                   help="also write the structured list as JSON to this path")
    p.add_argument("--md", default=OUT_MD_DEFAULT, dest="md_path", metavar="CAMINHO",
                   help=f"markdown output path (default: {OUT_MD_DEFAULT})")
    return p.parse_args()


def get_senha(args):
    if args.password and args.password.strip():
        return args.password.strip()
    s = os.environ.get("FEEDBACK_PASSWORD", "").strip()
    if not s:
        sys.exit("Error: provide the dashboard password: "
                 "python transcribe-feedback.py <PASSWORD>  (or FEEDBACK_PASSWORD=...)")
    return s


def get_groq_key():
    """API key from the environment first; falls back to a local env file."""
    k = os.environ.get("GROQ_API_KEY", "").strip()
    if k:
        return k
    if not os.path.exists(GROQ_ENV_FALLBACK):
        sys.exit("Error: the API key is not in the environment and the fallback env file "
                 f"does not exist at {GROQ_ENV_FALLBACK}")
    with open(GROQ_ENV_FALLBACK, encoding="utf-8") as f:
        for line in f:
            if line.strip().startswith("GROQ_API_KEY"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit(f"Error: API key not found in the environment or in {GROQ_ENV_FALLBACK}")


def ler_feedbacks(dashboard_password):
    """POSTs the password to the read function and returns the feedback list."""
    req = urllib.request.Request(
        EDGE_FN_URL,
        data=json.dumps({"password": dashboard_password}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read()).get("feedbacks", [])
    except urllib.error.HTTPError as e:
        if e.code == 401:
            sys.exit("Error: incorrect dashboard password.")
        sys.exit(f"Error reading feedback: HTTP {e.code}")
    except urllib.error.URLError as e:
        sys.exit(f"Network error calling the read function: {e.reason}")


def is_legacy(fb):
    """A legacy row predates the scope migration (no project and no material)."""
    return not (fb.get("project") or fb.get("material"))


def _igual(a, b):
    """Case-insensitive comparison, tolerant of surrounding whitespace."""
    return (a or "").strip().lower() == (b or "").strip().lower()


def passa_filtro(fb, args):
    """
    Apply the command-line filters to the fields the backend function returned.

    Regras (plano §5, entrega da frente 1):
      - --reviewer matches the reviewer name field (legacy rows included).
      - A LEGACY row (no project or material) is included when no scope filter is
        active; with a filter on, it needs --include-legacy.
      - A scoped row must match --project and --material when those are given.
    """
    if args.reviewer and not _igual(fb.get("reviewer_name"), args.reviewer):
        return False

    tem_filtro_escopo = bool(args.project or args.material)
    if is_legacy(fb):
        return (not tem_filtro_escopo) or args.include_legacy

    if args.project and not _igual(fb.get("project"), args.project):
        return False
    if args.material and not _igual(fb.get("material"), args.material):
        return False
    return True


def transcribe(url, groq_key):
    """
    Downloads the audio from its signed URL to a UNIQUE temporary file and
    com Groq Whisper (whisper-large-v3, language=pt) via curl.
    transcribes it. The temporary file is ALWAYS removed, including when the
    download or the transcription fails midway.
    """
    fd, tmp = tempfile.mkstemp(prefix="fb_audio_", suffix=".webm")
    os.close(fd)  # the downloader writes by path, not through the descriptor
    try:
        try:
            urllib.request.urlretrieve(url, tmp)
        except Exception as e:
            return f"[error downloading audio: {e}]"
        try:
            out = subprocess.run([
                "curl", "-s", "https://api.groq.com/openai/v1/audio/transcriptions",
                "-H", f"Authorization: Bearer {groq_key}",
                "-F", f"file=@{tmp}", "-F", f"model={GROQ_MODEL}",
                "-F", "language=pt", "-F", "response_format=json",
            ], capture_output=True, text=True, encoding="utf-8", timeout=120)
            data = json.loads(out.stdout or "{}")
            txt = (data.get("text") or "").strip()
            return txt if txt else "[audio sem fala reconhecivel]"
        except subprocess.TimeoutExpired:
            # NEVER use str(e) here: the timeout message includes the full command line,
            # whole curl command line, including the "Authorization: Bearer" header.
            # That would leak the API key into the markdown or JSON output.
            return "[transcription error: timed out after 120s]"
        except Exception as e:
            # Safety belt: if any other exception carries the key in its message,
            # mask it before writing to the output files.
            msg = str(e).replace(groq_key, "***") if groq_key else str(e)
            return f"[transcription error: {msg}]"
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def montar_markdown(fbs, n_audio, args):
    """Markdown grouped by section."""
    filtros = []
    if args.project:
        filtros.append(f"project_name = {args.project}")
    if args.material:
        filtros.append(f"material = {args.material}")
    if args.reviewer:
        filtros.append(f"reviewer = {args.reviewer}")
    if args.include_legacy:
        filtros.append("legacy included")
    rotulo_filtro = f" (filtro: {'; '.join(filtros)})" if filtros else ""

    lines = ["# Feedbacks transcritos", "",
              f"Total: {len(fbs)} feedback item(s), {n_audio} with audio (transcribed below)."
              f"{rotulo_filtro}",
              "Generated por `transcribe-feedbacks.py` (skill collaborative-review).",
              "", "---", ""]

    by_section = defaultdict(list)
    for f in fbs:
        by_section[f.get("section") or "(no section)"].append(f)

    for section in sorted(by_section):
        lines.append(f"## {section}")
        lines.append("")
        for f in by_section[section]:
            name = f.get("reviewer_name", "?")
            data = str(f.get("created_at", ""))[:16].replace("T", " ")
            escopo = ""
            if f.get("project") or f.get("material"):
                escopo = f" · {f.get('project') or '?'} / {f.get('material') or '?'}"
            marcador = " - REVIEW CONCLUSION" if f.get("type") == "conclusion" else ""
            lines.append(f"**{name}** · {data}{escopo}{marcador}")
            if f.get("comment"):
                lines.append(f"> {f['comment']}")
            if f.get("_transcript"):
                lines.append(f"> 🎙 (audio) {f['_transcript']}")
            lines.append("")
        lines.append("")
    return "\n".join(lines)


def montar_json(fbs):
    """
    Structured list for the correction engine.
    Formato: [{id, reviewer, section_value, comment_text, transcript, kind, created_at}]
    """
    return [{
        "id":          f.get("id"),
        "reviewer":     f.get("reviewer_name"),
        "section":       f.get("section"),
        "comment":  f.get("comment"),
        "transcript": f.get("_transcript"),  # None when there is no audio
        "type":        f.get("type") or "comment",
        "created_at":  f.get("created_at"),
    } for f in fbs]


def main():
    check_template_was_filled_in()
    args = parse_args()
    dashboard_password = get_senha(args)
    groq_key = get_groq_key()

    print("Lendo feedbacks do painel...")
    all = ler_feedbacks(dashboard_password)
    fbs = [f for f in all if passa_filtro(f, args)]
    discarded = len(all) - len(fbs)
    print(f"  {len(all)} feedback(s) no total; {len(fbs)} apos filtro"
          f" ({discarded} fora do filtro)." if discarded
          else f"  {len(fbs)} feedback(s) found.")

    fbs.sort(key=lambda f: f.get("created_at") or "")
    n_audio = 0
    for f in fbs:
        if f.get("audio_url"):
            n_audio += 1
            print(f"  transcribing audio from {f.get('reviewer_name')} ({n_audio})...")
            f["_transcript"] = transcribe(f["audio_url"], groq_key)

    with open(args.md_path, "w", encoding="utf-8") as fp:
        fp.write(montar_markdown(fbs, n_audio, args))
    print(f"OK (markdown) -> {args.md_path}")

    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as fp:
            json.dump(montar_json(fbs), fp, ensure_ascii=False, indent=2)
        print(f"OK (json)     -> {args.json_path}")


if __name__ == "__main__":
    main()
