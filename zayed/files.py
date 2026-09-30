"""Session uploads: storage, extraction, retrieval and retention."""

import json
import logging
import mimetypes
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from .documents import ExtractedDocument, Section, extract, kind_for
from .knowledge import BM25Index, Hit, chunk_document

logger = logging.getLogger("zayed.files")

_ID = re.compile(r"^[a-f0-9]{32}$")
RETENTION_SECONDS = 24 * 3600


@dataclass
class StoredFile:
    id: str
    session_id: str
    filename: str
    kind: str
    size: int
    mime: str
    uploaded_at: float
    path: Path
    preview: dict
    sections: list[Section]
    asset_types: list[str]

    def public(self) -> dict:
        return {
            "id": self.id,
            "origin": "upload",
            "title": self.filename,
            "filename": self.filename,
            "kind": self.kind,
            "size": self.size,
            "mime": self.mime,
            "preview": self.preview,
            "raw_url": f"/api/files/{self.id}/raw",
            "asset_base": f"/api/files/{self.id}/assets/",
            "has_text": any(s.text for s in self.sections),
        }


class FileStore:
    def __init__(self, root: Path, max_bytes: int):
        self.root = root
        self.max_bytes = max_bytes
        self.files: dict[str, StoredFile] = {}
        self.index = BM25Index()
        self.root.mkdir(parents=True, exist_ok=True)

    def load(self) -> "FileStore":
        now = time.time()
        for meta_path in self.root.glob("*/meta.json"):
            folder = meta_path.parent
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                if now - meta["uploaded_at"] > RETENTION_SECONDS:
                    self._purge(folder)
                    continue
                self._register(meta, folder)
            except (OSError, KeyError, json.JSONDecodeError):
                logger.warning("Discarding unreadable upload %s", folder)
                self._purge(folder)
        return self

    def save(self, session_id: str, filename: str, data: bytes) -> StoredFile:
        filename = Path(filename or "upload").name[:180]
        kind_for(filename)
        if not data:
            raise ValueError("The file is empty.")
        if len(data) > self.max_bytes:
            raise ValueError(f"The file exceeds the {self.max_bytes // (1024 * 1024)} MB limit.")
        extracted = extract(data, filename)
        file_id = uuid.uuid4().hex
        folder = self.root / file_id
        folder.mkdir(parents=True)
        (folder / ("original" + Path(filename).suffix.lower())).write_bytes(data)
        asset_types = []
        for number, (content_type, blob) in enumerate(extracted.assets):
            (folder / f"asset-{number}").write_bytes(blob)
            asset_types.append(content_type)
        meta = {
            "id": file_id,
            "session_id": session_id,
            "filename": filename,
            "kind": extracted.kind,
            "size": len(data),
            "mime": mimetypes.guess_type(filename)[0] or "application/octet-stream",
            "uploaded_at": time.time(),
            "preview": extracted.preview,
            "sections": [{"label": s.label, "text": s.text} for s in extracted.sections],
            "asset_types": asset_types,
        }
        (folder / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        return self._register(meta, folder)

    def _register(self, meta: dict, folder: Path) -> StoredFile:
        original = next(folder.glob("original*"))
        sections = [Section(s["label"], s["text"]) for s in meta["sections"]]
        stored = StoredFile(
            meta["id"],
            meta["session_id"],
            meta["filename"],
            meta["kind"],
            meta["size"],
            meta["mime"],
            meta["uploaded_at"],
            original,
            meta["preview"],
            sections,
            meta.get("asset_types", []),
        )
        self.files[stored.id] = stored
        extracted = ExtractedDocument(stored.kind, sections, stored.preview)
        self.index.add(chunk_document(stored.id, stored.filename, extracted))
        return stored

    def get(self, file_id: str) -> StoredFile | None:
        return self.files.get(file_id) if _ID.match(file_id or "") else None

    def asset(self, file_id: str, number: int) -> tuple[Path, str] | None:
        stored = self.get(file_id)
        if not stored or not 0 <= number < len(stored.asset_types):
            return None
        return stored.path.parent / f"asset-{number}", stored.asset_types[number]

    def delete(self, file_id: str) -> bool:
        stored = self.get(file_id)
        if not stored:
            return False
        self.files.pop(file_id, None)
        self.index.remove_doc(file_id)
        self._purge(stored.path.parent)
        return True

    def search(self, query: str, file_ids: list[str], limit: int = 4) -> list[Hit]:
        ids = {f for f in file_ids if f in self.files}
        return self.index.search(query, limit, ids) if ids else []

    def leading_chunks(self, file_id: str, limit: int = 4):
        return [c for c in self.index.chunks if c.doc_id == file_id][:limit]

    @staticmethod
    def _purge(folder: Path) -> None:
        for item in folder.glob("*"):
            item.unlink(missing_ok=True)
        folder.rmdir()
