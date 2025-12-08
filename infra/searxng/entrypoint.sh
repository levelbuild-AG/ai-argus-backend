#!/bin/sh
set -euo pipefail

CUSTOM_DIR=/custom-searxng
TEMPLATE_FILE="$CUSTOM_DIR/settings.yml"
TARGET_FILE=/etc/searxng/settings.yml
ENGINE_SRC_DIR="$CUSTOM_DIR/engines"
ENGINE_TARGET_DIR=/usr/local/searxng/searx/engines

render_template() {
  python3 <<'PY'
import os
import sys
from pathlib import Path
from string import Template

template_path = Path(os.environ['SEARXNG_TEMPLATE_FILE'])
target_path = Path(os.environ['SEARXNG_TARGET_FILE'])
content = template_path.read_text(encoding='utf-8')
tpl = Template(content)
try:
    rendered = tpl.substitute(os.environ)
except KeyError as exc:
    missing = exc.args[0]
    sys.stderr.write(f"Missing environment variable for SearXNG template: {missing}\n")
    sys.exit(1)
target_path.parent.mkdir(parents=True, exist_ok=True)
target_path.write_text(rendered, encoding='utf-8')
PY
}

install_custom_engines() {
  if [ ! -d "$ENGINE_SRC_DIR" ]; then
    return
  fi

  for engine_file in "$ENGINE_SRC_DIR"/*.py; do
    [ -e "$engine_file" ] || continue
    cp "$engine_file" "$ENGINE_TARGET_DIR/$(basename "$engine_file")"
  done
}

if [ -f "$TEMPLATE_FILE" ]; then
  export SEARXNG_TEMPLATE_FILE="$TEMPLATE_FILE"
  export SEARXNG_TARGET_FILE="$TARGET_FILE"
  render_template
fi

install_custom_engines

exec /usr/local/searxng/entrypoint.sh "$@"

