from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class BoundingBox(BaseModel):
    left: float = Field(ge=0)
    top: float = Field(ge=0)
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class ManagedField(BaseModel):
    id: str
    label: str
    page: int = Field(ge=1)
    candidate_ids: list[str] = Field(alias="candidateIds")
    bbox: BoundingBox
    original_bbox: Optional[BoundingBox] = Field(
        default=None, alias="originalBbox"
    )
    source_bbox: Optional[BoundingBox] = Field(default=None, alias="sourceBbox")
    original_text: str = Field(alias="originalText")
    current_text: str = Field(alias="currentText")
    font_family: str = Field(alias="fontFamily")
    font_size: float = Field(alias="fontSize", gt=0)
    original_font_size: float = Field(alias="originalFontSize", gt=0)
    bold: bool = False
    color: str = "#000000"
    original_color: str = Field(alias="originalColor")
    background_mode: Literal["auto", "manual"] = Field(
        default="auto", alias="backgroundMode"
    )
    background_color: str = Field(default="#ffffff", alias="backgroundColor")
    original_background_color: str = Field(alias="originalBackgroundColor")
    align: Literal["left", "center", "right"] = "left"
    original_align: Literal["left", "center", "right"] = Field(
        alias="originalAlign"
    )
    list_style: Literal["none", "bullet", "number"] = Field(
        default="none", alias="listStyle"
    )
    original_list_style: Literal["none", "bullet", "number"] = Field(
        default="none", alias="originalListStyle"
    )
    first_line_tab: bool = Field(default=False, alias="firstLineTab")
    original_first_line_tab: bool = Field(
        default=False, alias="originalFirstLineTab"
    )
    line_height: float = Field(default=1.13, alias="lineHeight", ge=0.8, le=3)
    original_line_height: float = Field(
        default=1.13, alias="originalLineHeight", ge=0.8, le=3
    )
    left_indent: float = Field(default=0, alias="leftIndent", ge=0)
    original_left_indent: float = Field(
        default=0, alias="originalLeftIndent", ge=0
    )
    first_line_indent: float = Field(default=0, alias="firstLineIndent")
    original_first_line_indent: float = Field(
        default=0, alias="originalFirstLineIndent"
    )
    tab_interval: float = Field(default=54, alias="tabInterval", gt=0)
    original_tab_interval: float = Field(
        default=54, alias="originalTabInterval", gt=0
    )
    tab_stops: list[float] = Field(default_factory=list, alias="tabStops")
    original_tab_stops: list[float] = Field(
        default_factory=list, alias="originalTabStops"
    )
    fit_mode: Literal["fixed", "shrink"] = Field(
        default="fixed", alias="fitMode"
    )

    @model_validator(mode="after")
    def populate_legacy_geometry(self) -> "ManagedField":
        if self.original_bbox is None:
            self.original_bbox = self.bbox.model_copy()
        if (
            self.source_bbox is None
            and self.candidate_ids
            and self.original_text
        ):
            self.source_bbox = self.original_bbox.model_copy()
        return self

    @field_validator(
        "color",
        "original_color",
        "background_color",
        "original_background_color",
    )
    @classmethod
    def validate_color(cls, value: str) -> str:
        if len(value) != 7 or not value.startswith("#"):
            raise ValueError("Colors must use #RRGGBB format")
        int(value[1:], 16)
        return value.lower()


class FieldChange(BaseModel):
    field_id: str = Field(alias="fieldId")
    label: str
    before: str
    after: str
    before_style: str = Field(alias="beforeStyle")
    after_style: str = Field(alias="afterStyle")


class FieldSnapshot(BaseModel):
    text: str
    bbox: Optional[BoundingBox] = None
    font_size: float = Field(alias="fontSize", gt=0)
    color: str
    background_mode: Literal["auto", "manual"] = Field(
        default="auto", alias="backgroundMode"
    )
    background_color: str = Field(alias="backgroundColor")
    align: Literal["left", "center", "right"]
    list_style: Literal["none", "bullet", "number"] = Field(
        default="none", alias="listStyle"
    )
    first_line_tab: bool = Field(default=False, alias="firstLineTab")
    line_height: float = Field(default=1.13, alias="lineHeight", ge=0.8, le=3)
    left_indent: float = Field(default=0, alias="leftIndent", ge=0)
    first_line_indent: float = Field(default=0, alias="firstLineIndent")
    tab_interval: float = Field(default=54, alias="tabInterval", gt=0)
    tab_stops: list[float] = Field(default_factory=list, alias="tabStops")


class Revision(BaseModel):
    id: str
    number: int = Field(ge=1)
    author: str
    note: str
    created_at: datetime = Field(alias="createdAt")
    changes: list[FieldChange]
    snapshot: dict[str, FieldSnapshot]


class MasterDocument(BaseModel):
    schema_version: int = Field(alias="schemaVersion")
    document_id: str = Field(alias="documentId")
    title: str
    source_pdf_hash: str = Field(alias="sourcePdfHash")
    coordinate_scale: float = Field(alias="coordinateScale", gt=0)
    fields: list[ManagedField]
    revisions: list[Revision] = []


class ExportRequest(BaseModel):
    document: MasterDocument
