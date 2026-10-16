"""Patch user testing templates to use RUNS rows per category."""

from __future__ import annotations

import re
from pathlib import Path

RUNS = 5

ROOT = Path(__file__).parent
MD = ROOT / "USER_TESTING_TEMPLATE.md"
HTML = ROOT / "exports" / "USER_TESTING_TEMPLATE.html"


# Build a Markdown table header with a centered run-number column and left-aligned data columns.
def md_table_header(*headers: str) -> str:
    line = "| " + " | ".join(headers) + " |"
    sep = "|" + "|".join(":---:" if i == 0 else ":---" for i in range(len(headers))) + "|"
    return f"{line}\n{sep}"


# Create blank Markdown run rows with the standard pass/fail/partial checkbox choices.
def md_pass_fail_rows() -> str:
    return "\n".join(f"| {n} | | ☐ | ☐ | ☐ | |" for n in range(1, RUNS + 1))


# Create Markdown landmark-test rows with the additional outcome checkbox column.
def md_landmark_rows() -> str:
    return "\n".join(f"| {n} | | ☐ | ☐ | ☐ | ☐ | |" for n in range(1, RUNS + 1))


# Create repeated Markdown voice-question rows seeded with representative location prompts.
def md_voice_questions() -> str:
    samples = [
        '*"What street am I on?"*',
        '*"What intersection am I at?"*',
        '*"What\'s near me?"*',
        '*"What businesses are around me?"*',
        '*"Am I facing north or south?"*',
    ]
    rows = []
    for n in range(1, RUNS + 1):
        q = samples[n - 1] if n <= len(samples) else ""
        rows.append(f"| {n} | {q} | ☐ | ☐ | ☐ | |")
    return "\n".join(rows)


# Create Markdown VoiceOver flow rows with representative app interactions to exercise.
def md_voiceover_flows() -> str:
    samples = [
        "Test 1A (storefront photo)",
        "Test 2 (navigation, ≥2 min or 2 steps)",
        "Submit + Tap to Ask labels only",
        "Test 1B (landmark video)",
        "Companion Mode controls",
    ]
    rows = []
    for n in range(1, RUNS + 1):
        flow = samples[n - 1] if n <= len(samples) else ""
        rows.append(f"| {n} | {flow} | ☐ | ☐ | ☐ | |")
    return "\n".join(rows)


# Create Markdown saved-place test rows with sample aliases and matching voice questions.
def md_saved_places() -> str:
    samples = [
        ("e.g. `test-home`", '*"How do I get to test-home?"*'),
        ("e.g. `work`", '*"How do I get to work?"*'),
        ("e.g. `home`", '*"How do I get home?"*'),
    ]
    rows = []
    for n in range(1, RUNS + 1):
        alias, q = samples[n - 1] if n <= len(samples) else ("", "")
        rows.append(f"| {n} | {alias} | {q} | ☐ | ☐ | ☐ | |")
    return "\n".join(rows)


# Create blank numbered Markdown destination rows for the configured run count.
def md_destinations() -> str:
    return "\n".join(f"| {n} | |" for n in range(1, RUNS + 1))


# Create numbered Markdown transit-test rows with inputs and outcome checkboxes.
def md_mta_rows() -> str:
    return "\n".join(f"| {n} | | | ☐ | ☐ | ☐ | |" for n in range(1, RUNS + 1))


# Replace one identified Markdown table through the next section boundary, failing explicitly if
# the expected table is absent.
def replace_table(text: str, table_start: str, new_block: str) -> str:
    pattern = table_start + r".*?(?=\n---\n|\n## |\n### |\Z)"
    text, n = re.subn(pattern, new_block.rstrip(), text, count=1, flags=re.DOTALL)
    if n == 0:
        raise SystemExit(f"Table not found: {table_start[:70]}...")
    return text


# Update the Markdown test instructions and category tables to the configured number of repeated
# runs.
def patch_md(text: str) -> str:
    text = re.sub(
        r"\*\*Run each test category \d+ times\.\*\*",
        f"**Run each test category {RUNS} times.**",
        text,
        count=1,
    )
    text = re.sub(
        r"Pick \*\*\d+ different destinations\*\*",
        f"Pick **{RUNS} different destinations**",
        text,
        count=1,
    )
    text = re.sub(r"\| /\d+ \|", f"| /{RUNS} |", text)

    text = replace_table(
        text,
        r"(?:\*\*Results — run \d+ times \(different storefronts\):\*\*\n\n)?\| Run \| Storefront / location tried",
        f"**Results — run {RUNS} times (different storefronts):**\n\n"
        + md_table_header("Run", "Storefront / location tried", "Pass", "Fail", "Partial", "Notes")
        + "\n"
        + md_pass_fail_rows(),
    )
    text = replace_table(
        text,
        r"(?:\*\*Results — run \d+ times \(different landmarks\):\*\*\n\n)?\| Run \| Landmark tried",
        f"**Results — run {RUNS} times (different landmarks):**\n\n"
        + md_table_header("Run", "Landmark tried", "Pass", "Fail", "Partial", "Skipped", "Notes")
        + "\n"
        + md_landmark_rows(),
    )
    text = replace_table(
        text,
        r"(?:\*\*Results — run \d+ times \(vary the question if you like\):\*\*\n\n)?\| Run \| Question spoken",
        f"**Results — run {RUNS} times (vary the question if you like):**\n\n"
        + md_table_header("Run", "Question spoken", "Pass", "Fail", "Partial", "Notes")
        + "\n"
        + md_voice_questions(),
    )
    text = replace_table(
        text,
        r"\| Run \| Destination \|\n\|:---:\|---\|",
        "| Run | Destination |\n|:---:|---|\n" + md_destinations(),
    )
    text = replace_table(
        text,
        r"(?:\*\*Results — \d+ navigation runs:\*\*\n\n)?\| Run \| Destination \| Pass \| Fail \| Partial \| Notes \(wrong turns",
        f"**Results — {RUNS} navigation runs:**\n\n"
        + md_table_header("Run", "Destination", "Pass", "Fail", "Partial", "Notes (wrong turns, off-route, etc.)")
        + "\n"
        + md_pass_fail_rows(),
    )
    text = replace_table(
        text,
        r"(?:\*\*Results — run \d+ times with VoiceOver / TalkBack on:\*\*\n\n)?\| Run \| Flow repeated",
        f"**Results — run {RUNS} times with VoiceOver / TalkBack on:**\n\n"
        + md_table_header("Run", "Flow repeated", "Pass", "Fail", "Partial", "Notes")
        + "\n"
        + md_voiceover_flows(),
    )
    text = replace_table(
        text,
        r"(?:\*\*Results — run \d+ times \(new session or re-open link each run if needed\):\*\*\n\n)?\| Run \| Contact / second device",
        f"**Results — run {RUNS} times (new session or re-open link each run if needed):**\n\n"
        + md_table_header("Run", "Contact / second device", "Pass", "Fail", "Partial", "Notes")
        + "\n"
        + md_pass_fail_rows(),
    )
    text = replace_table(
        text,
        r"(?:\*\*Results — run \d+ times \(different aliases or questions\):\*\*\n\n)?\| Run \| Alias saved",
        f"**Results — run {RUNS} times (different aliases or questions):**\n\n"
        + md_table_header("Run", "Alias saved", "Question asked", "Pass", "Fail", "Partial", "Notes")
        + "\n"
        + md_saved_places(),
    )
    text = replace_table(
        text,
        r"(?:\*\*Results — run \d+ times \(different lines or stations when possible\):\*\*\n\n)?\| Run \| Line asked",
        f"**Results — run {RUNS} times (different lines or stations when possible):**\n\n"
        + md_table_header("Run", "Line asked", "Station named in answer", "Pass", "Fail", "Partial", "Notes")
        + "\n"
        + md_mta_rows(),
    )
    return text


# Create editable HTML run rows with the requested standard or skip-capable outcome controls.
def html_simple_rows(skip: bool = False) -> str:
    lines = []
    for n in range(1, RUNS + 1):
        if skip:
            lines.append(
                f'  <tr><td>{n}</td><td><input type="text" /></td>'
                f'<td class="check"><input type="checkbox" /></td>'
                f'<td class="check"><input type="checkbox" /></td>'
                f'<td class="check"><input type="checkbox" /></td>'
                f'<td class="check"><input type="checkbox" /></td>'
                f"<td><input type=\"text\" /></td></tr>"
            )
        else:
            lines.append(
                f'  <tr><td>{n}</td><td><input type="text" /></td>'
                f'<td class="check"><input type="checkbox" /></td>'
                f'<td class="check"><input type="checkbox" /></td>'
                f'<td class="check"><input type="checkbox" /></td>'
                f"<td><input type=\"text\" /></td></tr>"
            )
    return "\n".join(lines)


# Create editable HTML voice-question rows seeded with representative prompts.
def html_voice_rows() -> str:
    samples = [
        "What street am I on?",
        "What intersection am I at?",
        "What's near me?",
        "What businesses are around me?",
        "Am I facing north or south?",
    ]
    lines = []
    for n in range(1, RUNS + 1):
        val = samples[n - 1] if n <= len(samples) else ""
        attr = f' value="{val}"' if val else ""
        lines.append(
            f'  <tr><td>{n}</td><td><input type="text"{attr} /></td>'
            f'<td class="check"><input type="checkbox" /></td>'
            f'<td class="check"><input type="checkbox" /></td>'
            f'<td class="check"><input type="checkbox" /></td>'
            f"<td><input type=\"text\" /></td></tr>"
        )
    return "\n".join(lines)


# Create editable HTML VoiceOver flow rows with the sample accessibility tasks.
def html_voiceover_rows() -> str:
    samples = [
        "Test 1A (storefront photo)",
        "Test 2 (navigation)",
        "Submit + Tap to Ask labels",
        "Test 1B (landmark video)",
        "Companion Mode controls",
    ]
    lines = []
    for n in range(1, RUNS + 1):
        flow = samples[n - 1] if n <= len(samples) else ""
        lines.append(
            f"  <tr><td>{n}</td><td>{flow}</td>"
            f'<td class="check"><input type="checkbox" /></td>'
            f'<td class="check"><input type="checkbox" /></td>'
            f'<td class="check"><input type="checkbox" /></td>'
            f"<td><input type=\"text\" /></td></tr>"
        )
    return "\n".join(lines)


# Create editable HTML saved-place rows with sample aliases and matching spoken requests.
def html_saved_rows() -> str:
    samples = [
        ("test-home", "How do I get to test-home?"),
        ("work", "How do I get to work?"),
        ("home", "How do I get home?"),
    ]
    lines = []
    for n in range(1, RUNS + 1):
        if n <= len(samples):
            alias, q = samples[n - 1]
            ph = f' placeholder="{alias}"'
            val = f' value="{q}"'
        else:
            ph, val = "", ""
        lines.append(
            f'  <tr><td>{n}</td><td><input type="text"{ph} /></td>'
            f'<td><input type="text"{val} /></td>'
            f'<td class="check"><input type="checkbox" /></td>'
            f'<td class="check"><input type="checkbox" /></td>'
            f'<td class="check"><input type="checkbox" /></td>'
            f"<td><input type=\"text\" /></td></tr>"
        )
    return "\n".join(lines)


# Create numbered HTML destination inputs for the configured run count.
def html_destinations() -> str:
    return "\n".join(
        f'  <tr><td>{n}</td><td><input type="text" placeholder="destination {n}" /></td></tr>'
        for n in range(1, RUNS + 1)
    )


# Create editable HTML transit rows with route/question inputs and result checkboxes.
def html_mta_rows() -> str:
    return "\n".join(
        f'  <tr><td>{n}</td><td><input type="text" /></td><td><input type="text" /></td>'
        f'<td class="check"><input type="checkbox" /></td>'
        f'<td class="check"><input type="checkbox" /></td>'
        f'<td class="check"><input type="checkbox" /></td>'
        f"<td><input type=\"text\" /></td></tr>"
        for n in range(1, RUNS + 1)
    )


# Update the HTML template's run-count instructions and replace each affected category table
# body.
def patch_html(text: str) -> str:
    text = re.sub(
        r"<strong>Run each category \d+ times</strong>",
        f"<strong>Run each category {RUNS} times</strong>",
        text,
        count=1,
    )
    text = re.sub(r"/\d+</td>", f"/{RUNS}</td>", text)

    html_blocks = [
        (
            r'<p class="section-note">Results — run \d+ times \(different storefronts\)</p>\n<table class="run-log">.*?</table>',
            f'<p class="section-note">Results — run {RUNS} times (different storefronts)</p>\n<table class="run-log">\n'
            f'  <tr><th>Run</th><th>Storefront / location</th><th class="check">Pass</th><th class="check">Fail</th><th class="check">Part.</th><th>Notes</th></tr>\n'
            f"{html_simple_rows()}\n</table>",
        ),
        (
            r'<p class="section-note">Results — run \d+ times \(different landmarks\)</p>\n<table class="run-log">.*?</table>',
            f'<p class="section-note">Results — run {RUNS} times (different landmarks)</p>\n<table class="run-log">\n'
            f'  <tr><th>Run</th><th>Landmark tried</th><th class="check">Pass</th><th class="check">Fail</th><th class="check">Part.</th><th class="check">Skip</th><th>Notes</th></tr>\n'
            f"{html_simple_rows(skip=True)}\n</table>",
        ),
        (
            r'<p class="section-note">Results — run \d+ times</p>\n<table class="run-log">\n  <tr><th>Run</th><th>Question spoken</th>.*?</table>',
            f'<p class="section-note">Results — run {RUNS} times</p>\n<table class="run-log">\n'
            f'  <tr><th>Run</th><th>Question spoken</th><th class="check">Pass</th><th class="check">Fail</th><th class="check">Part.</th><th>Notes</th></tr>\n'
            f"{html_voice_rows()}\n</table>",
        ),
        (
            r'<p><strong>Destinations \(\d+ runs, 5–10 min walk each\):</strong></p>\n<table class="run-log">.*?</table>',
            f'<p><strong>Destinations ({RUNS} runs, 5–10 min walk each):</strong></p>\n<table class="run-log">\n'
            f"  <tr><th>Run</th><th>Destination</th></tr>\n{html_destinations()}\n</table>",
        ),
        (
            r'<p class="section-note">Results — repeat navigation script for each run(?: \(\d+ runs\))?</p>\n<table class="run-log">.*?</table>',
            f'<p class="section-note">Results — repeat navigation script for each run ({RUNS} runs)</p>\n<table class="run-log">\n'
            f'  <tr><th>Run</th><th>Destination</th><th class="check">Pass</th><th class="check">Fail</th><th class="check">Part.</th><th>Notes</th></tr>\n'
            f"{html_simple_rows()}\n</table>",
        ),
        (
            r'<p class="section-note">Results — run \d+ times with VoiceOver on</p>\n<table class="run-log">.*?</table>',
            f'<p class="section-note">Results — run {RUNS} times with VoiceOver on</p>\n<table class="run-log">\n'
            f'  <tr><th>Run</th><th>Flow repeated</th><th class="check">Pass</th><th class="check">Fail</th><th class="check">Part.</th><th>Notes</th></tr>\n'
            f"{html_voiceover_rows()}\n</table>",
        ),
        (
            r'<p class="section-note">Results — run \d+ times</p>\n<table class="run-log">\n  <tr><th>Run</th><th>Contact / second device</th>.*?</table>',
            f'<p class="section-note">Results — run {RUNS} times</p>\n<table class="run-log">\n'
            f'  <tr><th>Run</th><th>Contact / second device</th><th class="check">Pass</th><th class="check">Fail</th><th class="check">Part.</th><th>Notes</th></tr>\n'
            f"{html_simple_rows()}\n</table>",
        ),
        (
            r'<p class="section-note">Results — run \d+ times \(different aliases\)</p>\n<table class="run-log">.*?</table>',
            f'<p class="section-note">Results — run {RUNS} times (different aliases)</p>\n<table class="run-log">\n'
            f'  <tr><th>Run</th><th>Alias</th><th>Question</th><th class="check">Pass</th><th class="check">Fail</th><th class="check">Part.</th><th>Notes</th></tr>\n'
            f"{html_saved_rows()}\n</table>",
        ),
        (
            r'<p class="section-note">Results — run \d+ times \(different lines when possible\)</p>\n<table class="run-log">.*?</table>',
            f'<p class="section-note">Results — run {RUNS} times (different lines when possible)</p>\n<table class="run-log">\n'
            f'  <tr><th>Run</th><th>Line asked</th><th>Station in answer</th><th class="check">Pass</th><th class="check">Fail</th><th class="check">Part.</th><th>Notes</th></tr>\n'
            f"{html_mta_rows()}\n</table>",
        ),
    ]

    for pattern, repl in html_blocks:
        text, n = re.subn(pattern, repl, text, count=1, flags=re.DOTALL)
        if n == 0:
            raise SystemExit(f"HTML pattern not found: {pattern[:60]}...")

    return text


# Write matching Markdown and HTML testing templates and exports, then regenerate the printable
# artifact.
def main() -> None:
    md_text = patch_md(MD.read_text(encoding="utf-8"))
    MD.write_text(md_text, encoding="utf-8")
    (ROOT / "exports" / "USER_TESTING_TEMPLATE.md").write_text(md_text, encoding="utf-8")

    html_text = patch_html(HTML.read_text(encoding="utf-8"))
    HTML.write_text(html_text, encoding="utf-8")

    slides = ROOT / "generate_user_testing_slides.py"
    slides_text = slides.read_text(encoding="utf-8")
    slides_text = re.sub(
        r"Run \*\*each test category \d+ times\*\*",
        f"Run **each test category {RUNS} times**",
        slides_text,
        count=1,
    )
    slides.write_text(slides_text, encoding="utf-8")

    print(f"Patched templates to {RUNS} runs per category.")


if __name__ == "__main__":
    main()
