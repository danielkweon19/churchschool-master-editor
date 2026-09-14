from __future__ import annotations

import io
import re

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .models import ExportRequest
from .pdf_service import ExportError, export_change_log, export_pdf


app = FastAPI(title="Chapter Master PDF Export Service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _filename(title: str, suffix: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-").lower()
    return f"{stem}-{suffix}.pdf"


def _pdf_response(content: bytes, filename: str) -> StreamingResponse:
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/export/pdf")
def create_pdf(request: ExportRequest) -> StreamingResponse:
    try:
        content = export_pdf(request.document)
    except ExportError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return _pdf_response(content, _filename(request.document.title, "revised"))


@app.post("/api/export/changelog")
def create_change_log(request: ExportRequest) -> StreamingResponse:
    try:
        content = export_change_log(request.document)
    except ExportError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return _pdf_response(content, _filename(request.document.title, "change-log"))

