#!/bin/sh
set -euo pipefail

CUSTOM_DIR=/custom-searxng
TEMPLATE_FILE="$CUSTOM_DIR/settings.yml"
TARGET_FILE=/etc/searxng/settings.yml

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

if [ -f "$TEMPLATE_FILE" ]; then
  export SEARXNG_TEMPLATE_FILE="$TEMPLATE_FILE"
  export SEARXNG_TARGET_FILE="$TARGET_FILE"
  render_template
fi

exec /usr/local/searxng/entrypoint.sh "$@"
