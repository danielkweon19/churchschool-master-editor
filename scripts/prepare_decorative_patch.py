#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

import pymupdf as fitz

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.pdf_service import (
    _decorative_redaction_rect,
    _remove_original_chapter_number_shadow,
)


SOURCE = ROOT / "public" / "source" / "chapter37.pdf"
OUTPUT = ROOT / "public" / "source" / "patch-p1-t1.png"
COORDINATE_SCALE = 1.5
PATCH_BOX = {
    "left": 49,
    "top": 31,
    "width": 73,
    "height": 116,
}


def main() -> None:
    document = fitz.open(SOURCE)
    page = document[0]
    span = next(
        span
        for block in page.get_text("rawdict").get("blocks", [])
        for line in block.get("lines", [])
        for span in line.get("spans", [])
        if "".join(char.get("c", "") for char in span.get("chars", [])) == "37"
        and "superclarendon" in span.get("font", "").lower()
    )

    _remove_original_chapter_number_shadow(document, page)
    page.add_redact_annot(
        _decorative_redaction_rect(span),
        fill=None,
        cross_out=False,
    )
    page.apply_redactions(images=0, graphics=0, text=0)

    clip = fitz.Rect(
        PATCH_BOX["left"] / COORDINATE_SCALE,
        PATCH_BOX["top"] / COORDINATE_SCALE,
        (PATCH_BOX["left"] + PATCH_BOX["width"]) / COORDINATE_SCALE,
        (PATCH_BOX["top"] + PATCH_BOX["height"]) / COORDINATE_SCALE,
    )
    pixmap = page.get_pixmap(
        matrix=fitz.Matrix(COORDINATE_SCALE, COORDINATE_SCALE),
        clip=clip,
        alpha=False,
    )
    pixmap.save(OUTPUT)
    document.close()
    print(f"Prepared decorative preview patch: {OUTPUT.name}")


if __name__ == "__main__":
    main()
