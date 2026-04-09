from __future__ import annotations

import argparse
import json
from pathlib import Path


DEFAULT_CONFIG = Path("userscript_release_config.json")
SOURCE_FILE = Path("mercari_todo_reply_slack.user.js")
DIST_DIR = Path("dist")
DIST_FILE = DIST_DIR / "mercari_todo_reply_slack.user.js"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build Tampermonkey userscript with GitHub auto-update URLs."
    )
    parser.add_argument(
        "--config",
        default=str(DEFAULT_CONFIG),
        help="Path to userscript_release_config.json",
    )
    return parser.parse_args()


def load_config(path: Path) -> dict:
    if not path.exists():
        raise RuntimeError(
            f"Release config not found: {path}. Copy userscript_release_config.example.json first."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def build_release(raw_url: str) -> Path:
    source_text = SOURCE_FILE.read_text(encoding="utf-8")
    rendered = (
        source_text.replace("__UPDATE_URL__", raw_url)
        .replace("__DOWNLOAD_URL__", raw_url)
    )
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    DIST_FILE.write_text(rendered, encoding="utf-8")
    return DIST_FILE


def main() -> int:
    args = parse_args()
    config = load_config(Path(args.config))
    raw_url = config["raw_userscript_url"].strip()
    if not raw_url.startswith("https://"):
        raise RuntimeError("raw_userscript_url must start with https://")
    output = build_release(raw_url)
    print(f"[done] userscript_release={output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
