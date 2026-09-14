from __future__ import annotations

import hashlib
import io
import re
from collections import Counter
from pathlib import Path
from typing import Iterable

import pymupdf as fitz

from .models import ManagedField, MasterDocument


ROOT = Path(__file__).resolve().parents[1]
SOURCE_PDF = ROOT / "public" / "source" / "chapter37.pdf"
FONT_ROOT = Path("/System/Library/Fonts/Supplemental")
FONT_FILES = {
    ("times", False): FONT_ROOT / "Times New Roman.ttf",
    ("times", True): FONT_ROOT / "Times New Roman Bold.ttf",
    ("superclarendon", False): FONT_ROOT / "SuperClarendon.ttc",
    ("superclarendon", True): FONT_ROOT / "SuperClarendon.ttc",
}


class ExportError(ValueError):
    pass


def _rgb(value: str) -> tuple[float, float, float]:
    return tuple(int(value[index : index + 2], 16) / 255 for index in (1, 3, 5))


def _font_for(field: ManagedField) -> tuple[str, str | None]:
    family = field.font_family.lower()
    key = "superclarendon" if "superclarendon" in family else "times"
    font_path = FONT_FILES.get((key, field.bold)) or FONT_FILES[("times", field.bold)]
    if font_path.exists():
        return f"managed-{key}-{'bold' if field.bold else 'regular'}", str(font_path)
    return ("Times-Bold" if field.bold else "Times-Roman"), None


def _alignment(value: str) -> int:
    return {
        "left": fitz.TEXT_ALIGN_LEFT,
        "center": fitz.TEXT_ALIGN_CENTER,
        "right": fitz.TEXT_ALIGN_RIGHT,
    }[value]


def _sample_background(
    page: fitz.Page, rect: fitz.Rect
) -> tuple[float, float, float]:
    zoom = 2
    pixmap = page.get_pixmap(
        matrix=fitz.Matrix(zoom, zoom),
        colorspace=fitz.csRGB,
        alpha=False,
    )
    page_rect = page.rect
    x0 = max(0, round((rect.x0 - page_rect.x0) * zoom))
    y0 = max(0, round((rect.y0 - page_rect.y0) * zoom))
    x1 = min(pixmap.width - 1, round((rect.x1 - page_rect.x0) * zoom))
    y1 = min(pixmap.height - 1, round((rect.y1 - page_rect.y0) * zoom))
    padding = 8
    thickness = 4
    samples: list[tuple[int, int, int]] = []

    def add_pixel(x: int, y: int) -> None:
        if 0 <= x < pixmap.width and 0 <= y < pixmap.height:
            offset = (y * pixmap.width + x) * pixmap.n
            red, green, blue = pixmap.samples[offset : offset + 3]
            samples.append(
                (
                    round(red / 4) * 4,
                    round(green / 4) * 4,
                    round(blue / 4) * 4,
                )
            )

    step = 2
    for x in range(x0, x1 + 1, step):
        for y in range(max(0, y0 - padding), max(0, y0 - thickness) + 1):
            add_pixel(x, y)
        for y in range(
            min(pixmap.height - 1, y1 + thickness),
            min(pixmap.height - 1, y1 + padding) + 1,
        ):
            add_pixel(x, y)
    for y in range(y0, y1 + 1, step):
        for x in range(max(0, x0 - padding), max(0, x0 - thickness) + 1):
            add_pixel(x, y)
        for x in range(
            min(pixmap.width - 1, x1 + thickness),
            min(pixmap.width - 1, x1 + padding) + 1,
        ):
            add_pixel(x, y)

    if not samples:
        return (1, 1, 1)
    red, green, blue = Counter(samples).most_common(1)[0][0]
    return (min(red, 255) / 255, min(green, 255) / 255, min(blue, 255) / 255)


def _validate_source(document: MasterDocument) -> None:
    if not SOURCE_PDF.exists():
        raise ExportError("The immutable source PDF has not been prepared.")
    actual_hash = hashlib.sha256(SOURCE_PDF.read_bytes()).hexdigest()
    if actual_hash != document.source_pdf_hash:
        raise ExportError(
            "The source PDF does not match this master document. "
            "Re-import the JSON backup against the correct source."
        )


def _source_span(
    page: fitz.Page,
    field: ManagedField,
    coordinate_scale: float,
) -> dict | None:
    if "\n" in field.original_text:
        return None
    target = fitz.Rect(
        field.bbox.left / coordinate_scale,
        field.bbox.top / coordinate_scale,
        (field.bbox.left + field.bbox.width) / coordinate_scale,
        (field.bbox.top + field.bbox.height) / coordinate_scale,
    )
    matches: list[tuple[float, dict]] = []
    for block in page.get_text("rawdict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = "".join(char.get("c", "") for char in span.get("chars", []))
                if text != field.original_text:
                    continue
                bbox = fitz.Rect(span["bbox"])
                score = abs(bbox.x0 - target.x0) + abs(bbox.y0 - target.y0)
                matches.append((score, span))
    return min(matches, key=lambda item: item[0])[1] if matches else None


def _is_chapter_number(field: ManagedField, span: dict | None) -> bool:
    return (
        field.page == 1
        and "p1-t1" in field.candidate_ids
        and span is not None
        and "superclarendon" in str(span.get("font", "")).lower()
    )


def _remove_original_chapter_number_shadow(pdf: fitz.Document, page: fitz.Page) -> None:
    marker = b"/GS1 gs\n/Fm0 Do\n"
    for xref in page.get_contents():
        stream = pdf.xref_stream(xref)
        if marker in stream:
            pdf.update_stream(xref, stream.replace(marker, b"", 1))
            return


def _decorative_redaction_rect(span: dict) -> fitz.Rect:
    bbox = fitz.Rect(span["bbox"])
    origin = fitz.Point(span["origin"])
    font_size = float(span["size"])
    # Large display fonts often report a descender box far below their
    # visible ink. Trim it so overlapping labels such as "chapter" survive.
    bbox.y1 = min(bbox.y1, origin.y + font_size * 0.2)
    return bbox + (-0.6, -0.4, 0.8, 0.5)


def _insert_fitted_single_line(
    page: fitz.Page,
    field: ManagedField,
    span: dict,
    font_name: str,
    font_file: str | None,
    draw_shadow: bool = False,
) -> bool:
    if not font_file:
        return False
    source_size = float(span["size"])
    size = source_size * (field.font_size / field.original_font_size)
    source_bbox = fitz.Rect(span["bbox"])
    target_width = source_bbox.width
    font = fitz.Font(fontfile=font_file)
    original_width = max(
        font.text_length(field.original_text, fontsize=size), 0.01
    )
    replacement_width = max(
        font.text_length(field.current_text, fontsize=size), 0.01
    )
    source_horizontal_scale = min(1.0, target_width / original_width)
    horizontal_scale = min(
        source_horizontal_scale,
        target_width / replacement_width,
    )
    if horizontal_scale < 0.55:
        return False

    origin = fitz.Point(span["origin"])
    morph = fitz.Matrix(horizontal_scale, 1)
    if draw_shadow:
        shadow_color = (0.56, 0.73, 0.82)
        for x_offset, y_offset in (
            (-1.4, -0.6),
            (-0.7, -0.8),
            (0, -0.9),
            (0.7, -0.7),
            (1.4, -0.4),
            (-1.5, 0.2),
            (-0.8, 0.1),
            (0, 0),
            (0.8, 0.2),
            (1.6, 0.4),
            (-1.2, 0.9),
            (-0.5, 1.1),
            (0.3, 1.2),
            (1.1, 1.1),
            (-0.6, 1.8),
            (0.2, 1.9),
            (1.0, 1.8),
        ):
            shadow_origin = fitz.Point(
                origin.x + x_offset,
                origin.y + y_offset,
            )
            page.insert_text(
                shadow_origin,
                field.current_text,
                fontname=font_name,
                fontfile=font_file,
                fontsize=size,
                color=shadow_color,
                morph=(shadow_origin, morph),
                overlay=True,
                fill_opacity=0.055,
            )
    page.insert_text(
        origin,
        field.current_text,
        fontname=font_name,
        fontfile=font_file,
        fontsize=size,
        color=_rgb(field.color),
        morph=(origin, morph),
        overlay=True,
    )
    return True


def _next_tab_stop(
    field: ManagedField,
    current_x: float,
    scale: float,
) -> float:
    custom_stops = sorted(
        stop * scale for stop in field.tab_stops if stop >= 0
    )
    for stop in custom_stops:
        if stop > current_x + 0.3:
            return stop
    interval = max(4.0, field.tab_interval * scale)
    return max(interval, (int(current_x / interval) + 1) * interval)


def _wrap_text(
    text: str,
    available_width: float,
    font: fitz.Font,
    font_size: float,
) -> list[str] | None:
    if text == "":
        return [""]
    if font.text_length(text, fontsize=font_size) <= available_width + 0.1:
        return [text]

    remaining = text
    lines: list[str] = []
    while remaining:
        fit_count = 0
        for index in range(1, len(remaining) + 1):
            if (
                font.text_length(remaining[:index], fontsize=font_size)
                > available_width + 0.1
            ):
                break
            fit_count = index
        if fit_count == 0:
            return None
        if fit_count == len(remaining):
            lines.append(remaining)
            break
        break_at = max(
            remaining.rfind(" ", 0, fit_count + 1),
            remaining.rfind("\u00a0", 0, fit_count + 1),
        )
        if break_at <= 0:
            return None
        lines.append(remaining[:break_at].rstrip(" \u00a0"))
        remaining = remaining[break_at + 1 :].lstrip(" \u00a0")
    return lines


def _insert_paragraph_text(
    page: fitz.Page,
    field: ManagedField,
    rect: fitz.Rect,
    font_name: str,
    font_file: str | None,
    scale: float,
) -> bool:
    try:
        font = (
            fitz.Font(fontfile=font_file)
            if font_file
            else fitz.Font(fontname="tibo" if field.bold else "tiro")
        )
    except RuntimeError:
        return False

    font_size = field.font_size * scale
    left_indent = field.left_indent * scale
    first_indent = (
        field.first_line_indent
        + (field.tab_interval if field.first_line_tab else 0)
    ) * scale
    right_edge = rect.x1
    line_advance = font_size * field.line_height
    layout: list[list[tuple[float, str]]] = []

    for logical_line in field.current_text.split("\n"):
        first_visual_line = len(layout) == 0
        line_start = rect.x0 + left_indent
        if first_visual_line:
            line_start += first_indent
        if line_start >= right_edge:
            return False

        if "\t" in logical_line:
            fragments: list[tuple[float, str]] = []
            current_x = line_start - rect.x0
            for index, fragment in enumerate(logical_line.split("\t")):
                if index > 0:
                    current_x = _next_tab_stop(field, current_x, scale)
                absolute_x = rect.x0 + current_x
                width = font.text_length(fragment, fontsize=font_size)
                if absolute_x + width > right_edge + 0.1:
                    return False
                fragments.append((absolute_x, fragment))
                current_x += width
            layout.append(fragments)
            continue

        available_width = right_edge - line_start
        wrapped = _wrap_text(
            logical_line,
            available_width,
            font,
            font_size,
        )
        if wrapped is None:
            return False
        for wrapped_index, wrapped_line in enumerate(wrapped):
            visual_start = (
                line_start
                if wrapped_index == 0
                else rect.x0 + left_indent
            )
            visual_available = right_edge - visual_start
            width = font.text_length(wrapped_line, fontsize=font_size)
            if field.align == "center":
                visual_start += max(0, (visual_available - width) / 2)
            elif field.align == "right":
                visual_start += max(0, visual_available - width)
            layout.append([(visual_start, wrapped_line)])

    if not layout:
        layout = [[(rect.x0 + left_indent + first_indent, "")]]
    first_baseline = rect.y0 + font.ascender * font_size
    last_baseline = first_baseline + (len(layout) - 1) * line_advance
    last_bottom = last_baseline - font.descender * font_size
    if last_bottom > rect.y1 + 1.5:
        return False

    for line_index, fragments in enumerate(layout):
        baseline = first_baseline + line_index * line_advance
        for x, fragment in fragments:
            if not fragment:
                continue
            page.insert_text(
                (x, baseline),
                fragment,
                fontname=font_name,
                fontfile=font_file,
                fontsize=font_size,
                color=_rgb(field.color),
                overlay=True,
            )
    return True


def _insert_list_text(
    page: fitz.Page,
    field: ManagedField,
    rect: fitz.Rect,
    font_name: str,
    font_file: str | None,
    scale: float,
) -> bool:
    try:
        font = (
            fitz.Font(fontfile=font_file)
            if font_file
            else fitz.Font(fontname="tibo" if field.bold else "tiro")
        )
    except RuntimeError:
        return False

    font_size = field.font_size * scale
    items = field.current_text.split("\n")
    item_count = sum(bool(item.strip()) for item in items)
    markers = [
        "\u2022" if field.list_style == "bullet" else f"{index}."
        for index in range(1, max(item_count, 1) + 1)
    ]
    marker_width = max(
        font.text_length(marker, fontsize=font_size) for marker in markers
    )
    gap = font_size * 0.55
    content_x = rect.x0 + marker_width + gap
    available_width = rect.x1 - content_x
    if available_width <= font_size:
        return False

    layout: list[list[tuple[float, str]]] = []
    numbered_index = 0
    for item in items:
        if not item.strip():
            layout.append([])
            continue
        marker = markers[numbered_index]
        numbered_index += 1
        wrapped = _wrap_text(item, available_width, font, font_size)
        if wrapped is None:
            return False
        marker_x = rect.x0 + marker_width - font.text_length(
            marker, fontsize=font_size
        )
        layout.append([(marker_x, marker), (content_x, wrapped[0])])
        layout.extend([[(content_x, line)] for line in wrapped[1:]])

    first_baseline = rect.y0 + font.ascender * font_size
    line_advance = font_size * field.line_height
    last_baseline = first_baseline + (len(layout) - 1) * line_advance
    last_bottom = last_baseline - font.descender * font_size
    if last_bottom > rect.y1 + 1.5:
        return False

    for line_index, fragments in enumerate(layout):
        baseline = first_baseline + line_index * line_advance
        for x, fragment in fragments:
            if not fragment:
                continue
            page.insert_text(
                (x, baseline),
                fragment,
                fontname=font_name,
                fontfile=font_file,
                fontsize=font_size,
                color=_rgb(field.color),
                overlay=True,
            )
    return True


def _was_changed(field: ManagedField) -> bool:
    return (
        field.current_text != field.original_text
        or abs(field.font_size - field.original_font_size) > 0.01
        or field.color != field.original_color
        or field.background_mode != "auto"
        or field.background_color != field.original_background_color
        or field.align != field.original_align
        or field.list_style != field.original_list_style
        or field.first_line_tab != field.original_first_line_tab
        or abs(field.line_height - field.original_line_height) > 0.001
        or abs(field.left_indent - field.original_left_indent) > 0.01
        or abs(field.first_line_indent - field.original_first_line_indent)
        > 0.01
        or abs(field.tab_interval - field.original_tab_interval) > 0.01
        or field.tab_stops != field.original_tab_stops
    )


def export_pdf(document: MasterDocument) -> bytes:
    _validate_source(document)
    pdf = fitz.open(SOURCE_PDF)
    changed = [field for field in document.fields if _was_changed(field)]

    for page_number in sorted({field.page for field in changed}):
        if page_number > len(pdf):
            raise ExportError(f"Field refers to missing page {page_number}.")
        page = pdf[page_number - 1]
        page_fields = [field for field in changed if field.page == page_number]
        source_spans = {
            field.id: _source_span(page, field, document.coordinate_scale)
            for field in page_fields
        }
        if any(
            _is_chapter_number(field, source_spans[field.id])
            for field in page_fields
        ):
            _remove_original_chapter_number_shadow(pdf, page)
        # The manifest uses 1.5 CSS pixels per PDF point.
        scale = 1 / document.coordinate_scale

        for field in page_fields:
            box = field.bbox
            source_span = source_spans[field.id]
            rect = (
                _decorative_redaction_rect(source_span)
                if _is_chapter_number(field, source_span)
                else fitz.Rect(source_span["bbox"]) + (-0.6, -0.4, 0.8, 0.8)
                if source_span is not None
                else fitz.Rect(
                    box.left * scale - 0.6,
                    box.top * scale - 0.4,
                    (box.left + box.width) * scale + 0.8,
                    (box.top + box.height) * scale + 0.8,
                )
            )
            background = (
                None
                if field.background_mode == "auto"
                else _rgb(field.background_color)
            )
            page.add_redact_annot(
                rect,
                fill=background,
                cross_out=False,
            )

        page.apply_redactions(images=0, graphics=0, text=0)

        for field in page_fields:
            box = field.bbox
            rect = fitz.Rect(
                box.left * scale,
                box.top * scale - 0.2,
                (box.left + box.width) * scale,
                (box.top + box.height) * scale + 1.2,
            )
            font_name, font_file = _font_for(field)
            source_span = source_spans[field.id]
            if (
                field.fit_mode == "shrink"
                and "\n" not in field.current_text
                and source_span is not None
                and _insert_fitted_single_line(
                    page,
                    field,
                    source_span,
                    font_name,
                    font_file,
                    draw_shadow=_is_chapter_number(field, source_span),
                )
            ):
                continue
            if field.list_style != "none":
                if _insert_list_text(
                    page,
                    field,
                    rect,
                    font_name,
                    font_file,
                    scale,
                ):
                    continue
                pdf.close()
                raise ExportError(
                    f'"{field.label}" list does not fit its PDF region. '
                    "Use fewer items, shorter text, or a smaller font."
                )
            uses_paragraph_layout = (
                "\t" in field.current_text
                or abs(field.left_indent) > 0.01
                or abs(field.first_line_indent) > 0.01
                or field.first_line_tab
                or bool(field.tab_stops)
            )
            if uses_paragraph_layout:
                if _insert_paragraph_text(
                    page,
                    field,
                    rect,
                    font_name,
                    font_file,
                    scale,
                ):
                    continue
                pdf.close()
                raise ExportError(
                    f'"{field.label}" does not fit its PDF region with the '
                    "current tabs and paragraph spacing."
                )
            base_size = field.font_size * scale
            size = base_size
            minimum_size = base_size
            remaining = -1.0
            while size >= minimum_size - 0.01:
                remaining = page.insert_textbox(
                    rect,
                    field.current_text,
                    fontname=font_name,
                    fontfile=font_file,
                    fontsize=size,
                    lineheight=field.line_height,
                    color=_rgb(field.color),
                    align=_alignment(field.align),
                    overlay=True,
                )
                if remaining >= -0.1:
                    break
                size -= max(0.25, base_size * 0.01)
            if remaining < -0.1:
                pdf.close()
                raise ExportError(
                    f'"{field.label}" does not fit its PDF region. '
                    "Shorten the text or reduce its font size."
                )

    output = io.BytesIO()
    pdf.set_metadata(
        {
            **pdf.metadata,
            "title": document.title,
            "subject": "Generated from the tracked Chapter Master document",
            "producer": "Chapter Master PDF Editor POC",
        }
    )
    pdf.save(output, garbage=4, deflate=True, clean=True)
    pdf.close()
    return output.getvalue()


def _safe_lines(text: str, width: int = 88) -> Iterable[str]:
    normalized = re.sub(r"\s+", " ", text).strip() or "(empty)"
    words = normalized.split(" ")
    line = ""
    for word in words:
        candidate = f"{line} {word}".strip()
        if len(candidate) > width and line:
            yield line
            line = word
        else:
            line = candidate
    if line:
        yield line


def export_change_log(document: MasterDocument) -> bytes:
    pdf = fitz.open()
    page = None
    y = 0.0
    margin = 54.0
    page_width = 612.0
    page_height = 792.0

    def new_page() -> fitz.Page:
        nonlocal y
        created = pdf.new_page(width=page_width, height=page_height)
        y = margin
        created.insert_text(
            (margin, y),
            document.title,
            fontname="hebo",
            fontsize=16,
            color=(0.06, 0.24, 0.32),
        )
        y += 22
        created.insert_text(
            (margin, y),
            "Tracked revision history",
            fontname="helv",
            fontsize=10,
            color=(0.35, 0.4, 0.43),
        )
        y += 28
        return created

    def write_line(
        text: str,
        *,
        size: float = 9.5,
        font: str = "helv",
        color: tuple[float, float, float] = (0.12, 0.14, 0.15),
        indent: float = 0,
        gap: float = 13,
    ) -> None:
        nonlocal page, y
        if page is None or y + gap > page_height - margin:
            page = new_page()
        page.insert_text(
            (margin + indent, y),
            text,
            fontname=font,
            fontsize=size,
            color=color,
        )
        y += gap

    if not document.revisions:
        page = new_page()
        write_line("No saved revisions yet.")
    else:
        for revision in reversed(document.revisions):
            if page is None or y > page_height - 130:
                page = new_page()
            date_label = revision.created_at.astimezone().strftime(
                "%B %d, %Y at %I:%M %p %Z"
            )
            write_line(
                f"Revision {revision.number} - {revision.author}",
                size=12,
                font="hebo",
                color=(0.02, 0.45, 0.61),
                gap=17,
            )
            write_line(date_label, size=8.5, color=(0.4, 0.43, 0.45))
            for line in _safe_lines(f"Note: {revision.note}", 90):
                write_line(line, size=9, indent=8)
            y += 5
            if not revision.changes:
                write_line("No content changes in this snapshot.", indent=8)
            for change in revision.changes:
                write_line(change.label, font="hebo", indent=8, gap=14)
                for line in _safe_lines(f"Before: {change.before}"):
                    write_line(line, size=8.5, indent=18, color=(0.48, 0.2, 0.2))
                for line in _safe_lines(f"After: {change.after}"):
                    write_line(line, size=8.5, indent=18, color=(0.12, 0.38, 0.24))
                if change.before_style != change.after_style:
                    for line in _safe_lines(
                        f"Formatting: {change.before_style} -> {change.after_style}"
                    ):
                        write_line(
                            line,
                            size=8,
                            indent=18,
                            color=(0.35, 0.4, 0.43),
                        )
                y += 5
            y += 10

    output = io.BytesIO()
    pdf.set_metadata(
        {
            "title": f"{document.title} - Change Log",
            "producer": "Chapter Master PDF Editor POC",
        }
    )
    pdf.save(output, garbage=4, deflate=True)
    pdf.close()
    return output.getvalue()
