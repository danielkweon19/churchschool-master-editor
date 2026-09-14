from __future__ import annotations

import hashlib
import unittest
from datetime import datetime, timezone
from pathlib import Path

import pymupdf as fitz

from backend.models import ManagedField, MasterDocument
from backend.pdf_service import (
    FIRST_LINE_TAB_EM,
    SOURCE_PDF,
    _sample_background,
    export_change_log,
    export_pdf,
    render_preview_page,
)


class PdfServiceTest(unittest.TestCase):
    def document(self) -> MasterDocument:
        source_hash = hashlib.sha256(Path(SOURCE_PDF).read_bytes()).hexdigest()
        return MasterDocument.model_validate(
            {
                "schemaVersion": 1,
                "documentId": "chapter-37-now-is-the-time-for-harvest",
                "title": "Chapter 37 - Now Is the Time for Harvest",
                "sourcePdfHash": source_hash,
                "coordinateScale": 1.5,
                "fields": [
                    {
                        "id": "opening-question",
                        "label": "Opening question",
                        "page": 1,
                        "candidateIds": ["p1-t12", "p1-t13"],
                        "bbox": {
                            "left": 78,
                            "top": 646,
                            "width": 489,
                            "height": 34,
                        },
                        "originalText": (
                            "In Aesop's fables, there is the story of the ant and "
                            "the grasshopper that we’re very familiar\n"
                            "with. Do you like the ant? Or the grasshopper? "
                            "What is the reason?"
                        ),
                        "currentText": (
                            "In Aesop's fables, consider the ant and the "
                            "grasshopper. Which one do you relate to, and why?"
                        ),
                        "fontFamily": "TimesNewRomanPSMT",
                        "fontSize": 14,
                        "originalFontSize": 14,
                        "bold": False,
                        "color": "#000000",
                        "originalColor": "#000000",
                        "backgroundColor": "#ffffff",
                        "originalBackgroundColor": "#ffffff",
                        "align": "left",
                        "originalAlign": "left",
                    }
                ],
                "revisions": [
                    {
                        "id": "revision-1",
                        "number": 1,
                        "author": "POC Test",
                        "note": "Clarify the opening discussion question.",
                        "createdAt": datetime.now(timezone.utc).isoformat(),
                        "changes": [
                            {
                                "fieldId": "opening-question",
                                "label": "Opening question",
                                "before": "Original opening question",
                                "after": "Revised opening question",
                                "beforeStyle": (
                                    "14pt, left, text #000000, "
                                    "background #ffffff"
                                ),
                                "afterStyle": (
                                    "14pt, left, text #000000, "
                                    "background #ffffff"
                                ),
                            }
                        ],
                        "snapshot": {
                            "opening-question": {
                                "text": "Revised opening question",
                                "fontSize": 14,
                                "color": "#000000",
                                "backgroundColor": "#ffffff",
                                "align": "left",
                            }
                        },
                    }
                ],
            }
        )

    def test_replaces_searchable_text_in_source_pdf(self) -> None:
        content = export_pdf(self.document())
        exported = fitz.open(stream=content, filetype="pdf")
        self.assertEqual(len(exported), 6)
        page_text = exported[0].get_text().replace("\xa0", " ")
        self.assertIn("Which one do you relate to", page_text)
        self.assertNotIn("Do you like the ant?", page_text)
        exported.close()

    def test_generates_change_log_pdf(self) -> None:
        content = export_change_log(self.document())
        exported = fitz.open(stream=content, filetype="pdf")
        text = "".join(page.get_text() for page in exported)
        self.assertIn("Revision 1", text)
        self.assertIn("Clarify the opening discussion question", text)
        exported.close()

    def test_automatically_preserves_a_colored_source_background(self) -> None:
        document = self.document()
        document.fields = [
            ManagedField.model_validate(
                {
                    "id": "series-heading",
                    "label": "Series heading",
                    "page": 1,
                    "candidateIds": ["p1-t4"],
                    "bbox": {
                        "left": 155,
                        "top": 46,
                        "width": 133,
                        "height": 18,
                    },
                    "originalText": "The Preaching of Jesus",
                    "currentText": "Hello",
                    "fontFamily": "TimesNewRomanPS",
                    "fontSize": 14,
                    "originalFontSize": 14,
                    "bold": True,
                    "color": "#00aeef",
                    "originalColor": "#00aeef",
                    "backgroundMode": "auto",
                    "backgroundColor": "#ffffff",
                    "originalBackgroundColor": "#ffffff",
                    "align": "left",
                    "originalAlign": "left",
                }
            )
        ]
        document.revisions = []

        source = fitz.open(SOURCE_PDF)
        source_rect = fitz.Rect(
            155 / 1.5 - 0.6,
            46 / 1.5 - 0.4,
            (155 + 133) / 1.5 + 0.8,
            (46 + 18) / 1.5 + 0.8,
        )
        expected = tuple(
            round(channel * 255)
            for channel in _sample_background(source[0], source_rect)
        )
        source.close()

        content = export_pdf(document)
        exported = fitz.open(stream=content, filetype="pdf")
        pixmap = exported[0].get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        actual = pixmap.pixel(round(180 * 2), round(36 * 2))[:3]
        self.assertLess(sum(abs(a - b) for a, b in zip(actual, expected)), 12)
        self.assertIn("Hello", exported[0].get_text())
        exported.close()

    def test_auto_fits_a_large_decorative_chapter_number(self) -> None:
        document = self.document()
        document.fields = [
            ManagedField.model_validate(
                {
                    "id": "chapter-number",
                    "label": "Chapter number",
                    "page": 1,
                    "candidateIds": ["p1-t1"],
                    "bbox": {
                        "left": 57,
                        "top": 39,
                        "width": 57,
                        "height": 100,
                    },
                    "originalText": "37",
                    "currentText": "38",
                    "fontFamily": "VAMJZR+Superclarendon",
                    "fontSize": 69,
                    "originalFontSize": 69,
                    "bold": True,
                    "color": "#00aeef",
                    "originalColor": "#00aeef",
                    "backgroundMode": "auto",
                    "backgroundColor": "#ffffff",
                    "originalBackgroundColor": "#ffffff",
                    "align": "left",
                    "originalAlign": "left",
                    "fitMode": "shrink",
                }
            )
        ]
        document.revisions = []

        content = export_pdf(document)
        exported = fitz.open(stream=content, filetype="pdf")
        text = exported[0].get_text()
        self.assertIn("38", text)
        self.assertNotIn("37", text)
        exported.close()

    def test_places_tabbed_text_at_custom_stops(self) -> None:
        document = self.document()
        field = document.fields[0]
        field.current_text = "Term\tMeaning\nHarvest\tGathering"
        field.line_height = 1.2
        field.original_line_height = 1.13
        field.tab_stops = [180]
        field.original_tab_stops = []
        document.revisions = []

        content = export_pdf(document)
        exported = fitz.open(stream=content, filetype="pdf")
        words = {
            word[4]: word
            for word in exported[0].get_text("words")
            if word[4] in {"Term", "Meaning", "Harvest", "Gathering"}
        }
        self.assertEqual(set(words), {"Term", "Meaning", "Harvest", "Gathering"})
        self.assertAlmostEqual(words["Meaning"][0], words["Gathering"][0], delta=0.5)
        self.assertAlmostEqual(
            words["Meaning"][0],
            field.bbox.left / document.coordinate_scale
            + 180 / document.coordinate_scale,
            delta=0.75,
        )
        self.assertAlmostEqual(
            words["Harvest"][1] - words["Term"][1],
            field.font_size / document.coordinate_scale * field.line_height,
            delta=0.75,
        )
        exported.close()

    def test_exports_bulleted_and_numbered_lists(self) -> None:
        for style, expected_markers in (
            ("bullet", {"•"}),
            ("number", {"1.", "2."}),
        ):
            with self.subTest(style=style):
                document = self.document()
                field = document.fields[0]
                field.current_text = "Prepare the field\n\nGather the harvest"
                field.bbox.height = 54
                field.list_style = style
                field.original_list_style = "none"
                document.revisions = []

                content = export_pdf(document)
                exported = fitz.open(stream=content, filetype="pdf")
                words = exported[0].get_text("words")
                word_text = {word[4] for word in words}
                self.assertTrue(expected_markers.issubset(word_text))
                self.assertNotIn("3.", word_text)
                prepare = next(word for word in words if word[4] == "Prepare")
                gather = next(word for word in words if word[4] == "Gather")
                self.assertAlmostEqual(prepare[0], gather[0], delta=0.5)
                self.assertAlmostEqual(
                    gather[1] - prepare[1],
                    2
                    * field.font_size
                    / document.coordinate_scale
                    * field.line_height,
                    delta=0.75,
                )
                exported.close()

    def test_indents_only_the_first_line_by_one_tab(self) -> None:
        document = self.document()
        field = document.fields[0]
        field.current_text = "Indented first\nSecond line"
        field.first_line_tab = True
        field.original_first_line_tab = False
        field.left_indent = 42
        field.first_line_indent = 18
        document.revisions = []

        content = export_pdf(document)
        exported = fitz.open(stream=content, filetype="pdf")
        words = exported[0].get_text("words")
        indented = next(word for word in words if word[4] == "Indented")
        second = next(word for word in words if word[4] == "Second")
        self.assertAlmostEqual(
            indented[0] - second[0],
            field.font_size
            * FIRST_LINE_TAB_EM
            / document.coordinate_scale,
            delta=0.75,
        )
        self.assertAlmostEqual(
            second[0],
            field.bbox.left / document.coordinate_scale,
            delta=0.75,
        )
        exported.close()

    def test_preview_page_uses_the_exact_export_renderer(self) -> None:
        document = self.document()
        field = document.fields[0]
        field.current_text = "Indented first\nSecond line"
        field.first_line_tab = True
        field.original_first_line_tab = False
        document.revisions = []

        preview = render_preview_page(document, 1)
        exported = fitz.open(stream=export_pdf(document), filetype="pdf")
        expected = exported[0].get_pixmap(
            matrix=fitz.Matrix(
                document.coordinate_scale,
                document.coordinate_scale,
            ),
            colorspace=fitz.csRGB,
            alpha=False,
        ).tobytes("png")
        exported.close()
        self.assertEqual(preview, expected)

    def test_moves_text_while_removing_it_from_the_source_location(self) -> None:
        document = self.document()
        field = document.fields[0]
        field.current_text = "Moved text"
        field.bbox.left += 90
        field.bbox.top += 45
        document.revisions = []

        content = export_pdf(document)
        exported = fitz.open(stream=content, filetype="pdf")
        words = exported[0].get_text("words")
        moved = next(word for word in words if word[4] == "Moved")
        self.assertAlmostEqual(
            moved[0],
            field.bbox.left / document.coordinate_scale,
            delta=0.75,
        )
        self.assertAlmostEqual(
            moved[1],
            field.bbox.top / document.coordinate_scale,
            delta=0.75,
        )
        page_text = exported[0].get_text()
        self.assertNotIn("Do you like the ant?", page_text)
        exported.close()

    def test_adds_a_new_text_box_without_a_source_redaction(self) -> None:
        document = self.document()
        document.fields = [
            ManagedField.model_validate(
                {
                    "id": "new-text-box",
                    "label": "New text box",
                    "page": 1,
                    "candidateIds": [],
                    "bbox": {
                        "left": 100,
                        "top": 700,
                        "width": 220,
                        "height": 40,
                    },
                    "originalBbox": {
                        "left": 100,
                        "top": 700,
                        "width": 220,
                        "height": 40,
                    },
                    "sourceBbox": None,
                    "originalText": "",
                    "currentText": "Added directly",
                    "fontFamily": "Times New Roman",
                    "fontSize": 14,
                    "originalFontSize": 14,
                    "bold": False,
                    "color": "#000000",
                    "originalColor": "#000000",
                    "backgroundMode": "auto",
                    "backgroundColor": "#ffffff",
                    "originalBackgroundColor": "#ffffff",
                    "align": "left",
                    "originalAlign": "left",
                }
            )
        ]
        document.revisions = []

        content = export_pdf(document)
        exported = fitz.open(stream=content, filetype="pdf")
        self.assertIn(
            "Added directly",
            exported[0].get_text().replace("\xa0", " "),
        )
        exported.close()


if __name__ == "__main__":
    unittest.main()
