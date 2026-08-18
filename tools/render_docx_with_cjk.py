"""Run the official document renderer with a CJK font in its temporary HOME.

The official renderer intentionally replaces HOME for LibreOffice isolation.
On macOS this can hide user/app-provided CJK fonts, so we copy WPS's bundled
Hanyi font into that disposable profile before invoking the original renderer.
"""

from __future__ import annotations

import importlib.util
import shutil
from pathlib import Path


RENDERER = Path("/Users/zhonghetong/.codex/plugins/cache/openai-primary-runtime/documents/26.813.12317/skills/documents/render_docx.py")
FONT = Path("/Applications/wpsoffice.app/Contents/Resources/office6/fonts/HYQiHei-55J.ttf")

spec = importlib.util.spec_from_file_location("official_render_docx", RENDERER)
if spec is None or spec.loader is None:
    raise RuntimeError("Unable to load the official render_docx.py")
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)

original_build_env = renderer._build_lo_env


def build_env_with_cjk(user_profile: str) -> dict:
    font_dir = Path(user_profile) / "Library" / "Fonts"
    font_dir.mkdir(parents=True, exist_ok=True)
    if FONT.exists():
        shutil.copy2(FONT, font_dir / FONT.name)
    return original_build_env(user_profile)


renderer._build_lo_env = build_env_with_cjk
renderer.main()
