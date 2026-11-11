"""Build the dispatcher cargo catalog from the effective ETS2 def/company tree."""
import argparse
import json
import re
from pathlib import Path

CARGO_FIELD = re.compile(r'^\s*cargo\s*:\s*"?cargo\.([\w.]+)"?', re.MULTILINE)
LEGACY_FIELD = re.compile(
    r'^\s*(in|out)_cargo\[\d*\]\s*:\s*"?cargo\.([\w.]+)"?', re.MULTILINE
)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("company_directory", type=Path, help="Extracted, merged def/company directory")
parser.add_argument("output", type=Path, help="Destination JSON file")
args = parser.parse_args()
root = args.company_directory
if not root.is_dir():
    parser.error("The def/company directory does not exist")

catalog = {}
for company in sorted(root.iterdir()):
    if not company.is_dir():
        continue
    cargo = {"in": set(), "out": set()}
    definition = company.with_suffix(".sii")
    if definition.is_file():
        for direction, cargo_id in LEGACY_FIELD.findall(definition.read_text(encoding="utf-8-sig")):
            cargo[direction].add(cargo_id)
    for direction, ids in cargo.items():
        for entry in sorted((company / direction).glob("*.sii")):
            matches = CARGO_FIELD.findall(entry.read_text(encoding="utf-8-sig"))
            if not matches:
                parser.error(f"Unrecognized cargo definition: {entry}")
            ids.update(matches)
    catalog[company.name] = {direction: sorted(ids) for direction, ids in cargo.items()}

if not catalog or not any(row["in"] or row["out"] for row in catalog.values()):
    parser.error("No company cargo definitions found")
args.output.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
