"""Zayed — ADCMC Digital Employee: FastAPI application."""

import logging
import mimetypes
import os
import re
from typing import Annotated

from fastapi import FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from zayed.assistant import Assistant
from zayed.config import BASE_DIR, settings
from zayed.documents import KIND_BY_EXTENSION, UnsupportedDocument
from zayed.files import FileStore
from zayed.knowledge import KnowledgeBase
from zayed.speech import SpeechService

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("zayed")

_SESSION = re.compile(r"^[A-Za-z0-9-]{8,64}$")

knowledge = KnowledgeBase(settings.knowledge_dir).load()
files = FileStore(settings.upload_dir, settings.max_upload_mb * 1024 * 1024).load()
assistant = Assistant(settings, knowledge, files)
speech = SpeechService(settings)

app = FastAPI(title="Zayed — ADCMC Digital Employee", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()")
    return response


class ChatRequest(BaseModel):
    session_id: str
    message: str = Field(min_length=1, max_length=4000)
    file_ids: list[str] = Field(default_factory=list, max_length=10)
    language: str = "en"
    language_detected: bool = False


class SessionRequest(BaseModel):
    session_id: str


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=3000)
    language: str = "en"


def _session(session_id: str | None) -> str:
    if not _SESSION.match(session_id or ""):
        raise HTTPException(400, "Invalid session id.")
    return session_id


SessionHeader = Annotated[str | None, Header(alias="X-Zayed-Session")]
SessionQuery = Annotated[str | None, Query(alias="session_id")]


def _owned_file(file_id: str, header: str | None, query: str | None):
    stored = files.get_owned(file_id, _session(header or query))
    if not stored:
        raise HTTPException(404, "File not found.")
    return stored


@app.get("/", response_class=HTMLResponse)
async def index():
    return (BASE_DIR / "static" / "index.html").read_text(encoding="utf-8")


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/api/config")
async def config():
    return {
        "assistant": {"name_en": "Zayed", "name_ar": "زايد", "organization": "ADCMC"},
        "capabilities": {
            "azure_speech": speech.enabled,
            "llm": assistant.client is not None,
            "llm_provider": assistant.provider,
        },
        "speech": {
            "region": settings.azure_speech_region if speech.enabled else None,
            "voices": {"en": settings.voice_en, "ar": settings.voice_ar},
            "recognition_languages": ["en-US", "ar-AE"],
        },
        "avatar": {"url": settings.avatar_url, "body": settings.avatar_body},
        "knowledge": {"documents": len(knowledge.documents), "rejected": len(knowledge.rejected)},
        "upload": {"max_mb": settings.max_upload_mb, "extensions": sorted(KIND_BY_EXTENSION)},
    }


@app.get("/api/speech/token")
async def speech_token():
    if not speech.enabled:
        raise HTTPException(503, "Azure Speech is not configured.")
    try:
        token = await run_in_threadpool(speech.token)
    except Exception as exc:
        logger.exception("Azure token request failed")
        raise HTTPException(502, "Could not obtain an Azure Speech token.") from exc
    return {"token": token, "region": settings.azure_speech_region}


@app.post("/api/speech/synthesize")
async def synthesize(request: SpeechRequest):
    if not speech.enabled:
        raise HTTPException(503, "Azure Speech is not configured.")
    language = "ar" if request.language == "ar" else "en"
    try:
        return await run_in_threadpool(speech.synthesize, request.text, language)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc


@app.post("/api/chat")
async def chat(request: ChatRequest):
    session_id = _session(request.session_id)
    language = "ar" if request.language == "ar" else "en"
    result = await run_in_threadpool(
        assistant.answer, session_id, request.message, request.file_ids, language, request.language_detected
    )
    return result.public()


@app.post("/api/session/reset")
async def reset_session(request: SessionRequest):
    assistant.forget(_session(request.session_id))
    return {"reset": True}


@app.get("/api/knowledge")
async def knowledge_index():
    return {"documents": [d.public() for d in knowledge.documents.values()]}


@app.get("/api/knowledge/{doc_id}")
async def knowledge_document(doc_id: str):
    doc = knowledge.documents.get(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found.")
    return {
        **doc.public(),
        "origin": "knowledge",
        "preview": doc.extracted.preview,
        "raw_url": f"/api/knowledge/{doc_id}/raw",
        "asset_base": f"/api/knowledge/{doc_id}/assets/",
    }


@app.get("/api/knowledge/{doc_id}/raw")
async def knowledge_raw(doc_id: str):
    doc = knowledge.documents.get(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found.")
    return FileResponse(doc.path, media_type=mimetypes.guess_type(doc.path.name)[0], content_disposition_type="inline")


@app.get("/api/knowledge/{doc_id}/assets/{number}")
async def knowledge_asset(doc_id: str, number: int):
    doc = knowledge.documents.get(doc_id)
    if not doc or not 0 <= number < len(doc.extracted.assets):
        raise HTTPException(404, "Asset not found.")
    content_type, blob = doc.extracted.assets[number]
    return Response(blob, media_type=content_type)


@app.post("/api/files")
async def upload(file: Annotated[UploadFile, File()], session_id: Annotated[str, Form()]):
    session_id = _session(session_id)
    data = await file.read(files.max_bytes + 1)
    try:
        stored = await run_in_threadpool(files.save, session_id, file.filename or "upload", data)
    except (UnsupportedDocument, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        logger.exception("Could not process upload %s", file.filename)
        raise HTTPException(422, "The file could not be read. It may be corrupted or password-protected.") from exc
    return stored.public()


@app.get("/api/files/{file_id}")
async def file_detail(file_id: str, header: SessionHeader = None, query: SessionQuery = None):
    return _owned_file(file_id, header, query).public()


@app.get("/api/files/{file_id}/raw")
async def file_raw(file_id: str, header: SessionHeader = None, query: SessionQuery = None):
    stored = _owned_file(file_id, header, query)
    return FileResponse(stored.path, media_type=stored.mime, content_disposition_type="inline")


@app.get("/api/files/{file_id}/assets/{number}")
async def file_asset(file_id: str, number: int, header: SessionHeader = None, query: SessionQuery = None):
    found = files.asset(file_id, _session(header or query), number)
    if not found:
        raise HTTPException(404, "Asset not found.")
    path, content_type = found
    return FileResponse(path, media_type=content_type)


@app.delete("/api/files/{file_id}")
async def file_delete(file_id: str, header: SessionHeader = None, query: SessionQuery = None):
    files.delete(_owned_file(file_id, header, query).id)
    return {"deleted": file_id}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
