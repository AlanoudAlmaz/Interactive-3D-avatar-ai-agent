"""Approved knowledge base: manifest-governed loading and BM25 retrieval."""

import json
import logging
import math
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from .documents import ExtractedDocument, Section, UnsupportedDocument, extract
from .text import detect_language, tokenize

logger = logging.getLogger("zayed.knowledge")

REQUIRED_FIELDS = ("id", "title", "file", "source", "owner", "approved_by", "approved_on", "status")
CHUNK_CHARS = 900


@dataclass
class Chunk:
    id: str
    doc_id: str
    doc_title: str
    label: str
    text: str
    anchor: dict
    tokens: list[str] = field(default_factory=list, repr=False)


@dataclass
class Hit:
    chunk: Chunk
    score: float
    coverage: float


class BM25Index:
    """Small in-memory BM25 index; adequate for curated document sets."""

    def __init__(self, k1: float = 1.5, b: float = 0.75):
        self.k1, self.b = k1, b
        self.chunks: list[Chunk] = []
        self._tf: list[Counter] = []
        self._df: Counter = Counter()
        self._avg_len = 0.0

    def add(self, chunks: list[Chunk]) -> None:
        for chunk in chunks:
            chunk.tokens = tokenize(f"{chunk.doc_title} {chunk.label} {chunk.text}")
            tf = Counter(chunk.tokens)
            self.chunks.append(chunk)
            self._tf.append(tf)
            self._df.update(tf.keys())
        total = sum(len(c.tokens) for c in self.chunks)
        self._avg_len = total / len(self.chunks) if self.chunks else 0.0

    def remove_doc(self, doc_id: str) -> None:
        keep = [c for c in self.chunks if c.doc_id != doc_id]
        self.chunks, self._tf, self._df = [], [], Counter()
        self.add(keep)

    def search(self, query: str, limit: int = 5, doc_ids: set[str] | None = None) -> list[Hit]:
        terms = list(dict.fromkeys(tokenize(query)))
        if not terms or not self.chunks:
            return []
        n = len(self.chunks)
        hits = []
        for chunk, tf in zip(self.chunks, self._tf):
            if doc_ids is not None and chunk.doc_id not in doc_ids:
                continue
            score, matched = 0.0, 0
            length = len(chunk.tokens) or 1
            for term in terms:
                freq = tf.get(term)
                if not freq:
                    continue
                matched += 1
                idf = math.log(1 + (n - self._df[term] + 0.5) / (self._df[term] + 0.5))
                score += idf * freq * (self.k1 + 1) / (freq + self.k1 * (1 - self.b + self.b * length / self._avg_len))
            if matched:
                hits.append(Hit(chunk, score, matched / len(terms)))
        hits.sort(key=lambda h: h.score, reverse=True)
        return hits[:limit]


def _anchor(kind: str, label: str) -> dict:
    if label.startswith("Page "):
        return {"page": int(label.split()[1])}
    if label.startswith("Slide "):
        return {"slide": int(label.split()[1])}
    if label.startswith("Sheet: "):
        return {"sheet": label[len("Sheet: ") :]}
    return {"heading": label} if label else {}


def chunk_document(doc_id: str, title: str, extracted: ExtractedDocument) -> list[Chunk]:
    chunks: list[Chunk] = []
    for section in extracted.sections:
        paragraphs = [p.strip() for p in section.text.split("\n") if p.strip()]
        buffer = ""
        for paragraph in paragraphs:
            if buffer and len(buffer) + len(paragraph) > CHUNK_CHARS:
                chunks.append(_make_chunk(doc_id, title, extracted.kind, section, buffer, len(chunks)))
                buffer = ""
            buffer = f"{buffer}\n{paragraph}".strip()
        if buffer:
            chunks.append(_make_chunk(doc_id, title, extracted.kind, section, buffer, len(chunks)))
    return chunks


def _make_chunk(doc_id: str, title: str, kind: str, section: Section, text: str, index: int) -> Chunk:
    return Chunk(f"{doc_id}#{index}", doc_id, title, section.label, text, _anchor(kind, section.label))


@dataclass
class KnowledgeDocument:
    id: str
    title: str
    title_ar: str
    path: Path
    meta: dict
    extracted: ExtractedDocument

    def public(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "title_ar": self.title_ar,
            "source": self.meta.get("source"),
            "owner": self.meta.get("owner"),
            "approved_by": self.meta.get("approved_by"),
            "approved_on": self.meta.get("approved_on"),
            "version": self.meta.get("version"),
            "language": self.meta.get("language"),
            "classification": self.meta.get("classification"),
            "kind": self.extracted.kind,
            "filename": self.path.name,
        }


class KnowledgeBase:
    """Only documents listed in manifest.json with complete approval metadata are indexed."""

    def __init__(self, root: Path):
        self.root = root
        self.documents: dict[str, KnowledgeDocument] = {}
        self.rejected: list[dict] = []
        self.index = BM25Index()

    def load(self) -> "KnowledgeBase":
        manifest_path = self.root / "manifest.json"
        if not manifest_path.exists():
            logger.warning("No knowledge manifest at %s", manifest_path)
            return self
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for entry in manifest.get("documents", []):
            reason = self._validate(entry)
            if reason:
                self.rejected.append({"id": entry.get("id"), "file": entry.get("file"), "reason": reason})
                logger.warning("Knowledge document %s skipped: %s", entry.get("id"), reason)
                continue
            path = (self.root / entry["file"]).resolve()
            try:
                extracted = extract(path.read_bytes(), path.name)
            except (OSError, UnsupportedDocument) as exc:
                self.rejected.append({"id": entry["id"], "file": entry["file"], "reason": str(exc)})
                continue
            except Exception:
                logger.exception("Knowledge document %s could not be parsed", entry["id"])
                self.rejected.append({"id": entry["id"], "file": entry["file"], "reason": "file could not be parsed"})
                continue
            doc = KnowledgeDocument(entry["id"], entry["title"], entry.get("title_ar", ""), path, entry, extracted)
            self.documents[doc.id] = doc
            self.index.add(chunk_document(doc.id, doc.title, extracted))
        logger.info("Knowledge base: %d approved documents, %d chunks", len(self.documents), len(self.index.chunks))
        return self

    def _validate(self, entry: dict) -> str:
        missing = [f for f in REQUIRED_FIELDS if not str(entry.get(f, "")).strip()]
        if missing:
            return "missing approval metadata: " + ", ".join(missing)
        if str(entry["status"]).lower() != "approved":
            return f"status is '{entry['status']}', not 'approved'"
        if entry["id"] in self.documents:
            return "duplicate id"
        path = (self.root / entry["file"]).resolve()
        if self.root.resolve() not in path.parents:
            return "file is outside the knowledge directory"
        if not path.is_file():
            return "file not found"
        return ""

    @property
    def languages(self) -> set[str]:
        langs = {str(d.meta.get("language", "")).lower() for d in self.documents.values()}
        return {lang for lang in langs if lang} or {detect_language(d.extracted.text) for d in self.documents.values()}

    def search(self, query: str, limit: int = 5) -> list[Hit]:
        return self.index.search(query, limit)
