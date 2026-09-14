#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import html
import json
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / "Chapter 37 - Now Is the Time for Harvest.pdf"
PUBLIC_SOURCE = ROOT / "public" / "source"
TARGET_PDF = PUBLIC_SOURCE / "chapter37.pdf"
MANIFEST = PUBLIC_SOURCE / "manifest.json"


def run(*args: str) -> None:
    subprocess.run(args, check=True)


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Source PDF not found: {SOURCE}")

    PUBLIC_SOURCE.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SOURCE, TARGET_PDF)

    for old_page in PUBLIC_SOURCE.glob("page-*.png"):
        old_page.unlink()

    with tempfile.TemporaryDirectory(prefix="chapter37-") as tmp:
        tmp_path = Path(tmp)
        render_prefix = tmp_path / "page"
        run("pdftoppm", "-png", "-r", "108", str(SOURCE), str(render_prefix))

        rendered = sorted(
            tmp_path.glob("page-*.png"),
            key=lambda path: int(path.stem.rsplit("-", 1)[1]),
        )
        for page_number, rendered_page in enumerate(rendered, 1):
            shutil.copy2(rendered_page, PUBLIC_SOURCE / f"page-{page_number}.png")

        xml_target = tmp_path / "layout.xml"
        run(
            "pdftohtml",
            "-xml",
            "-hidden",
            "-nodrm",
            str(SOURCE),
            str(xml_target),
        )
        tree = ET.parse(xml_target)

    pages: list[dict] = []
    candidates: list[dict] = []
    for page_element in tree.getroot().findall("page"):
        page_number = int(page_element.attrib["number"])
        page_width = float(page_element.attrib["width"])
        page_height = float(page_element.attrib["height"])
        fonts = {
            element.attrib["id"]: {
                "family": element.attrib.get("family", "Times New Roman"),
                "size": float(element.attrib.get("size", "14")),
                "color": element.attrib.get("color", "#000000"),
            }
            for element in page_element.findall("fontspec")
        }

        pages.append(
            {
                "number": page_number,
                "width": page_width,
                "height": page_height,
                "image": f"/source/page-{page_number}.png",
            }
        )

        for index, text_element in enumerate(page_element.findall("text"), 1):
            raw_text = "".join(text_element.itertext())
            text = html.unescape(raw_text).strip()
            if not text:
                continue
            font = fonts.get(text_element.attrib.get("font", ""), {})
            candidates.append(
                {
                    "id": f"p{page_number}-t{index}",
                    "page": page_number,
                    "text": text,
                    "bbox": {
                        "left": float(text_element.attrib["left"]),
                        "top": float(text_element.attrib["top"]),
                        "width": float(text_element.attrib["width"]),
                        "height": float(text_element.attrib["height"]),
                    },
                    "style": {
                        "fontFamily": font.get("family", "Times New Roman"),
                        "fontSize": font.get("size", 14),
                        "color": font.get("color", "#000000"),
                        "bold": text_element.find("b") is not None,
                    },
                }
            )

    digest = hashlib.sha256(TARGET_PDF.read_bytes()).hexdigest()
    patch_script = ROOT / "scripts" / "prepare_decorative_patch.py"
    venv_python = ROOT / ".venv" / "bin" / "python"
    patch_ready = False
    if venv_python.exists():
        run(str(venv_python), str(patch_script))
        patch_ready = (PUBLIC_SOURCE / "patch-p1-t1.png").exists()

    if patch_ready:
        for candidate in candidates:
            if candidate["id"] == "p1-t1":
                candidate["previewPatch"] = "/source/patch-p1-t1.png"
                candidate["previewPatchBox"] = {
                    "left": 49,
                    "top": 31,
                    "width": 73,
                    "height": 116,
                }

    payload = {
        "schemaVersion": 1,
        "documentId": "chapter-37-now-is-the-time-for-harvest",
        "title": "Chapter 37 - Now Is the Time for Harvest",
        "sourcePdf": "/source/chapter37.pdf",
        "sourcePdfHash": digest,
        "coordinateScale": 1.5,
        "pages": pages,
        "candidates": candidates,
    }
    MANIFEST.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(
        f"Prepared {len(pages)} pages and {len(candidates)} selectable text lines."
    )


if __name__ == "__main__":
    main()
