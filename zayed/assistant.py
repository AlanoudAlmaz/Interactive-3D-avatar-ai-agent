"""Grounded question answering: Zayed answers only from approved or user-provided sources."""

import base64
import json
import logging
import re
from collections import OrderedDict, deque
from dataclasses import dataclass, field

from openai import AzureOpenAI, OpenAI

from .config import Settings
from .files import FileStore
from .knowledge import Chunk, Hit, KnowledgeBase
from .text import detect_language

logger = logging.getLogger("zayed.assistant")

# Retrieval thresholds. The LLM makes the final groundedness call; extractive mode is stricter
# because it quotes the passage directly without reasoning over it.
LLM_MIN_SCORE, LLM_MIN_COVERAGE = 0.8, 0.3
EXTRACTIVE_MIN_SCORE, EXTRACTIVE_MIN_COVERAGE = 1.5, 0.5
HISTORY_TURNS = 6
MAX_SESSIONS = 2000

REFUSAL = {
    "en": (
        "I don't have verified information on that in the approved ADCMC knowledge base, so I won't guess. "
        "Please consult the responsible department or an official ADCMC source."
    ),
    "ar": (
        "لا تتوفر لديّ معلومات موثّقة حول هذا الموضوع في قاعدة المعرفة المعتمدة لدى ADCMC، ولن أقدّم أي تخمين. "
        "يُرجى الرجوع إلى الإدارة المختصة أو إلى مصدر رسمي معتمد."
    ),
}
GREETING = {
    "en": "Hello, I'm Zayed, your ADCMC digital employee. Ask me a question, or upload a document and I'll open it for you.",
    "ar": "مرحبًا، أنا زايد، الموظف الرقمي لدى ADCMC. اطرح سؤالك، أو ارفع مستندًا وسأفتحه لك.",
}
THANKS = {
    "en": "You're welcome. I'm here whenever you need me.",
    "ar": "على الرحب والسعة، أنا في خدمتك متى احتجت.",
}
NEEDS_LLM = {
    "en": "Summarising or analysing a file requires the language model, which is not configured. Here is the most relevant passage I found:",
    "ar": "يتطلب تلخيص الملفات أو تحليلها تفعيل النموذج اللغوي، وهو غير مُفعّل حاليًا. هذا أقرب مقطع ذي صلة:",
}
IMAGE_ONLY = {
    "en": "I can display this image, but describing its contents requires the language model, which is not configured.",
    "ar": "يمكنني عرض هذه الصورة، لكن وصف محتواها يتطلب تفعيل النموذج اللغوي، وهو غير مُفعّل حاليًا.",
}

_GREETING_RE = re.compile(
    r"^\s*(hi|hello|hey|good (morning|afternoon|evening)|salam|assalam[ou] ?alaikum|مرحبا|مرحبًا|أهلا|اهلا|السلام عليكم|صباح الخير|مساء الخير)[\s!.,،]*$",
    re.IGNORECASE,
)
_THANKS_RE = re.compile(r"^\s*(thanks|thank you|thx|شكرا|شكرًا|مشكور|يعطيك العافية)[\s!.,،]*$", re.IGNORECASE)
_OPEN_RE = re.compile(r"\b(open|show|display|view|bring up)\b|افتح|اعرض|أظهر|اظهر|عرض", re.IGNORECASE)
_FILE_REF_RE = re.compile(
    r"\b(this|the|my|uploaded|attached) (file|document|doc|pdf|presentation|deck|slides?|sheet|spreadsheet|image|picture|report)\b"
    r"|\b(summari[sz]e|summary|analy[sz]e)\b|الملف|المستند|العرض|الصورة|الجدول|لخص|ملخص|حلل",
    re.IGNORECASE,
)

SYSTEM_PROMPT = """You are Zayed, the official AI digital employee of ADCMC. You serve government employees.

STRICT GROUNDING RULES
1. Answer ONLY using the numbered SOURCES provided in the user message. Never use outside knowledge about ADCMC,
   its people, policies, numbers, dates, procedures or services.
2. If the sources do not clearly contain the answer, set "grounded" to false. Do not guess, infer, or fill gaps.
3. [S#] sources are approved ADCMC knowledge. [U#] sources are files uploaded by the employee: you may summarise or
   explain them, but make clear the information comes from the uploaded file, not from verified ADCMC knowledge.
4. Cite every factual sentence with its source tag, e.g. [S1] or [U2].
5. Reply in {language_name}. Be precise, professional and concise (at most 110 words; short bullet lists allowed,
   no headings, no tables). Your reply is also spoken aloud, so write natural sentences.
6. Set "open" to the source tag whose document the employee asked to see or would most benefit from opening, else null.

Respond with JSON only: {{"grounded": true|false, "answer": "...", "citations": ["S1"], "open": "S1"|null}}"""


@dataclass
class Answer:
    text: str
    language: str
    grounded: bool
    mode: str
    sources: list[dict] = field(default_factory=list)
    action: dict | None = None

    def public(self) -> dict:
        return {
            "answer": self.text,
            "language": self.language,
            "grounded": self.grounded,
            "mode": self.mode,
            "sources": self.sources,
            "action": self.action,
        }


@dataclass
class _Source:
    tag: str
    chunk: Chunk
    origin: str


class Assistant:
    def __init__(self, settings: Settings, knowledge: KnowledgeBase, files: FileStore):
        self.settings = settings
        self.knowledge = knowledge
        self.files = files
        self.history: OrderedDict[str, deque] = OrderedDict()
        self.client = self._client()

    def _client(self):
        if self.settings.azure_openai_enabled:
            self.model = self.settings.azure_openai_deployment
            return AzureOpenAI(
                api_key=self.settings.azure_openai_key,
                azure_endpoint=self.settings.azure_openai_endpoint,
                api_version=self.settings.azure_openai_api_version,
            )
        if self.settings.openai_enabled:
            self.model = self.settings.openai_model
            return OpenAI(api_key=self.settings.openai_key)
        self.model = ""
        return None

    @property
    def provider(self) -> str:
        if self.settings.azure_openai_enabled:
            return "azure-openai"
        return "openai" if self.settings.openai_enabled else "none"

    def answer(
        self,
        session_id: str,
        message: str,
        file_ids: list[str],
        ui_language: str = "en",
        language_detected: bool = False,
    ) -> Answer:
        message = message.strip()
        if language_detected or not re.search(r"[^\W\d_]", message):
            language = ui_language
        else:
            language = detect_language(message)
        file_ids = [f for f in file_ids if (stored := self.files.get(f)) and stored.session_id == session_id]

        if _GREETING_RE.match(message):
            return self._remember(session_id, message, Answer(GREETING[language], language, True, "conversational"))
        if _THANKS_RE.match(message):
            return self._remember(session_id, message, Answer(THANKS[language], language, True, "conversational"))

        sources = self._retrieve(message, file_ids, language)
        images = [self.files.get(f) for f in file_ids if self.files.get(f).kind == "image"]
        refers_to_file = bool(_FILE_REF_RE.search(message))

        if self.client:
            answer = self._answer_llm(
                session_id, message, language, sources, images if (refers_to_file or not sources) else []
            )
        else:
            answer = self._answer_extractive(message, language, sources, images, refers_to_file)

        if answer.grounded and answer.sources and not answer.action and _OPEN_RE.search(message):
            answer.action = {"type": "open", "document": answer.sources[0]}
        return self._remember(session_id, message, answer)

    def _retrieve(self, message: str, file_ids: list[str], language: str) -> list[_Source]:
        min_score, min_cov = (
            (LLM_MIN_SCORE, LLM_MIN_COVERAGE) if self.client else (EXTRACTIVE_MIN_SCORE, EXTRACTIVE_MIN_COVERAGE)
        )
        query = message
        if self.client and self.knowledge.languages - {language}:
            query = f"{message} {self._translate_query(message, language)}"

        kb_hits = [h for h in self.knowledge.search(query, 4) if h.score >= min_score and h.coverage >= min_cov]
        upload_hits: list[Hit] = [h for h in self.files.search(message, file_ids, 4) if h.coverage >= min_cov]
        upload_chunks = [h.chunk for h in upload_hits]
        if file_ids and _FILE_REF_RE.search(message) and not upload_chunks:
            for file_id in file_ids[-2:]:
                upload_chunks.extend(self.files.leading_chunks(file_id, 3))

        sources = [_Source(f"S{i}", h.chunk, "knowledge") for i, h in enumerate(kb_hits, start=1)]
        sources += [_Source(f"U{i}", c, "upload") for i, c in enumerate(upload_chunks, start=1)]
        return sources

    def _translate_query(self, message: str, language: str) -> str:
        target = "English" if language == "ar" else "Arabic"
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                temperature=0,
                max_tokens=60,
                messages=[
                    {
                        "role": "system",
                        "content": f"Translate the user's question into {target} search keywords. Output keywords only.",
                    },
                    {"role": "user", "content": message},
                ],
            )
            return response.choices[0].message.content or ""
        except Exception:
            logger.exception("Query translation failed")
            return ""

    def _answer_llm(self, session_id: str, message: str, language: str, sources: list[_Source], images: list) -> Answer:
        if not sources and not images:
            return Answer(REFUSAL[language], language, False, "llm")
        blocks = []
        for source in sources:
            origin = "Approved ADCMC knowledge" if source.origin == "knowledge" else "Uploaded file"
            label = f", {source.chunk.label}" if source.chunk.label else ""
            blocks.append(f"[{source.tag}] ({origin}: {source.chunk.doc_title}{label})\n{source.chunk.text}")
        image_tags = {}
        for number, image in enumerate(images, start=len([s for s in sources if s.origin == "upload"]) + 1):
            image_tags[f"U{number}"] = image
            blocks.append(f"[U{number}] (Uploaded image: {image.filename}) — attached below.")
        prompt = "SOURCES\n" + "\n\n".join(blocks) + f"\n\nEMPLOYEE QUESTION\n{message}"
        content: list[dict] | str = prompt
        if image_tags:
            content = [{"type": "text", "text": prompt}]
            for image in image_tags.values():
                encoded = base64.b64encode(image.path.read_bytes()).decode("ascii")
                content.append({"type": "image_url", "image_url": {"url": f"data:{image.mime};base64,{encoded}"}})

        messages = [
            {
                "role": "system",
                "content": SYSTEM_PROMPT.format(language_name="Arabic" if language == "ar" else "English"),
            }
        ]
        messages += list(self.history.get(session_id, []))
        messages.append({"role": "user", "content": content})
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                temperature=0,
                max_tokens=450,
                response_format={"type": "json_object"},
                messages=messages,
            )
            data = json.loads(response.choices[0].message.content or "{}")
        except Exception:
            logger.exception("LLM call failed")
            return Answer(REFUSAL[language], language, False, "llm")

        by_tag = {s.tag: s for s in sources}
        cited = [t for t in data.get("citations", []) if t in by_tag or t in image_tags]
        answer_text = str(data.get("answer", "")).strip()
        if not data.get("grounded") or not cited or not answer_text:
            return Answer(REFUSAL[language], language, False, "llm")

        public_sources = self._public_sources([by_tag[t] for t in cited if t in by_tag])
        for tag in cited:
            if tag in image_tags:
                public_sources.append(self._file_source(tag, image_tags[tag]))
        action = None
        open_tag = data.get("open")
        if open_tag in cited:
            target = next((s for s in public_sources if s["tag"] == open_tag), None)
            if target:
                action = {"type": "open", "document": target}
        return Answer(answer_text, language, True, "llm", public_sources, action)

    def _answer_extractive(
        self, message: str, language: str, sources: list[_Source], images: list, refers_to_file: bool
    ) -> Answer:
        if not sources:
            if images and refers_to_file:
                return Answer(
                    IMAGE_ONLY[language], language, False, "extractive", [self._file_source("U1", images[-1])]
                )
            return Answer(REFUSAL[language], language, False, "extractive")
        best = sources[0]
        excerpt = best.chunk.text.strip()
        if best.chunk.label and excerpt.startswith(best.chunk.label):
            excerpt = excerpt[len(best.chunk.label) :].lstrip(" :\n")
        if len(excerpt) > 600:
            excerpt = excerpt[:600].rsplit(" ", 1)[0] + "…"
        doc_title = best.chunk.doc_title
        if language == "ar" and best.origin == "knowledge":
            doc_title = self.knowledge.documents[best.chunk.doc_id].title_ar or doc_title
        title = doc_title + (
            f" — {best.chunk.label}" if best.chunk.label and best.chunk.label != best.chunk.doc_title else ""
        )
        if best.origin == "upload" and re.search(r"summari|summary|analy|لخص|ملخص|حلل", message, re.IGNORECASE):
            prefix = NEEDS_LLM[language]
        elif best.origin == "upload":
            prefix = f"من الملف المرفوع «{title}»:" if language == "ar" else f"From your uploaded file “{title}”:"
        else:
            prefix = (
                f"وفقًا للمصدر المعتمد «{title}»:"
                if language == "ar"
                else f"According to the approved source “{title}”:"
            )
        return Answer(f"{prefix}\n{excerpt} [{best.tag}]", language, True, "extractive", self._public_sources([best]))

    def _public_sources(self, sources: list[_Source]) -> list[dict]:
        result = []
        for source in sources:
            chunk = source.chunk
            if source.origin == "knowledge":
                doc = self.knowledge.documents[chunk.doc_id]
                meta = {
                    "approved_by": doc.meta.get("approved_by"),
                    "approved_on": doc.meta.get("approved_on"),
                    "source": doc.meta.get("source"),
                    "version": doc.meta.get("version"),
                }
                title_ar = doc.title_ar
            else:
                meta, title_ar = {}, ""
            result.append(
                {
                    "tag": source.tag,
                    "origin": source.origin,
                    "id": chunk.doc_id,
                    "title": chunk.doc_title,
                    "title_ar": title_ar,
                    "section": chunk.label,
                    "anchor": chunk.anchor,
                    "excerpt": chunk.text[:280],
                    **meta,
                }
            )
        return result

    @staticmethod
    def _file_source(tag: str, stored) -> dict:
        return {
            "tag": tag,
            "origin": "upload",
            "id": stored.id,
            "title": stored.filename,
            "title_ar": "",
            "section": "",
            "anchor": {},
            "excerpt": "",
        }

    def forget(self, session_id: str) -> None:
        self.history.pop(session_id, None)

    def _remember(self, session_id: str, message: str, answer: Answer) -> Answer:
        history = self.history.setdefault(session_id, deque(maxlen=HISTORY_TURNS * 2))
        self.history.move_to_end(session_id)
        while len(self.history) > MAX_SESSIONS:
            self.history.popitem(last=False)
        history.append({"role": "user", "content": message})
        history.append(
            {
                "role": "assistant",
                "content": json.dumps({"grounded": answer.grounded, "answer": answer.text}, ensure_ascii=False),
            }
        )
        return answer
