# SPDX-License-Identifier: AGPL-3.0-or-later
"""Google Programmable Search (Custom Search Engine).

This engine uses the official Google Custom Search JSON API.
"""

from __future__ import annotations

import os
from urllib.parse import urlencode

from searx import logger
from searx.exceptions import SearxEngineAPIException
from searx.utils import html_to_text

about = {
    "website": "https://programmablesearchengine.google.com/",
    "official_api_documentation": "https://developers.google.com/custom-search/v1/overview",
    "use_official_api": True,
    "require_api_key": True,
    "results": "JSON",
}

categories = ["general", "web", "news"]
paging = True
safesearch = True
time_range_support = True

_base_url = "https://customsearch.googleapis.com/customsearch/v1"
_results_per_page = 10
_safesearch_map = {0: "off", 1: "active", 2: "active"}
_time_range_map = {"day": "d1", "week": "w1", "month": "m1", "year": "y1"}

_api_key = ""
_cx = ""

log = logger.getChild("searx.engines.google_cs")


def setup(engine_settings: dict[str, str]) -> bool:
    """Capture credentials from the engine configuration or environment."""

    global _api_key, _cx  # pylint: disable=global-statement

    _api_key = (engine_settings.get("api_key") or os.environ.get("GOOGLE_SEARCH_API_KEY") or "").strip()
    _cx = (engine_settings.get("cx") or os.environ.get("GOOGLE_CSE_ID") or "").strip()

    if not _api_key or not _cx:
        log.error("Google Custom Search engine requires both api_key and cx")
        return False

    return True


def request(query: str, params: dict) -> dict:
    """Build the HTTP request for the Custom Search API."""

    start_index = 1 + (params.get("pageno", 1) - 1) * _results_per_page
    # API only allows start indices up to 91 when num=10
    start_index = max(1, min(start_index, 91))

    args: dict[str, str | int] = {
        "key": _api_key,
        "cx": _cx,
        "q": query,
        "start": start_index,
        "num": _results_per_page,
    }

    safesearch_value = _safesearch_map.get(params.get("safesearch", 0), "off")
    args["safe"] = safesearch_value

    time_range = params.get("time_range")
    if time_range in _time_range_map:
        args["dateRestrict"] = _time_range_map[time_range]

    locale = params.get("searxng_locale", "all")
    if locale not in ("all", "auto"):
        normalized = locale.replace("_", "-")
        args["hl"] = normalized
        args["lr"] = f"lang_{normalized.split('-')[0]}"

    params["url"] = f"{_base_url}?{urlencode(args)}"
    params.setdefault("headers", {})["Accept"] = "application/json"
    return params


def response(resp):
    """Parse Google Programmable Search results."""

    try:
        payload = resp.json()
    except ValueError as exc:  # pragma: no cover - network failure edge case
        raise SearxEngineAPIException("Google CSE returned invalid JSON") from exc

    if "error" in payload:
        error = payload["error"]
        message = error.get("message", "Google CSE error")
        code = error.get("code")
        raise SearxEngineAPIException(f"Google CSE error ({code}): {message}")

    results = []
    for item in payload.get("items", []):
        title = item.get("title")
        link = item.get("link")
        snippet = item.get("snippet") or html_to_text(item.get("htmlSnippet", ""))

        if not link:
            continue

        result = {
            "title": title,
            "url": link,
            "content": snippet,
            "source": item.get("displayLink"),
        }

        thumbnail = _extract_thumbnail(item)
        if thumbnail:
            result["thumbnail"] = thumbnail

        results.append(result)

    return results


def _extract_thumbnail(item: dict) -> str | None:
    pagemap = item.get("pagemap") or {}
    thumbnails = pagemap.get("cse_thumbnail") or []
    if thumbnails:
        thumb_src = thumbnails[0].get("src")
        if thumb_src:
            return thumb_src

    metatags = pagemap.get("metatags") or []
    for tag in metatags:
        for key in ("og:image", "twitter:image", "twitter:image:src"):
            value = tag.get(key)
            if value:
                return value
    return None
