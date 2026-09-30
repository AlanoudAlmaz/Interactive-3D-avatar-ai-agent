<div align="center">

# Zayed — ADCMC Digital Employee

A government-grade AI employee with a talking holographic face, bilingual (Arabic / English) voice and chat,
answers grounded **only** in approved ADCMC sources, and a floating document workspace controlled by
mouse, touch, keyboard, voice and hand gestures.

</div>

---

## Experience

**Speak / Type / Upload → Zayed understands → answers by voice + text with citations → opens the relevant content → you control it naturally.**

| Area | What it does |
| --- | --- |
| Holographic face | Photo-realistic talking portrait of Zayed inside a restrained cyan hologram frame. Azure Speech neural voices drive audio; Azure visemes drive jaw and lip movement with coarticulation and loudness; Azure word timings drive nods, eyebrow raises, head turns and phrase-end blinks, with eye saccades at rest. |
| Voice | Azure Speech recognition with automatic Arabic / English detection (browser speech recognition as a fallback). Replies are spoken with `ar-AE-HamdanNeural` or `en-US-AndrewMultilingualNeural`. |
| Chat | Lightweight conversation panel, Enter to send, Shift+Enter for a new line, citation chips (`S1`, `U1`) and verified / not-verified badges. |
| Trusted knowledge | Only documents listed in `knowledge/manifest.json` with complete approval metadata are indexed. Anything else is refused with a clear "not verified" answer. |
| Uploads | PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx, .xlsm, .csv), images (PNG, JPG, GIF, WebP) and text (.txt, .md, .json). Session-scoped, kept for 24 hours, never added to the approved knowledge base. |
| Workspace | Floating windows with zoom, pan, scroll, page / slide / sheet navigation, minimize to dock, maximize, restore and close. |
| Gestures | Mouse wheel / drag, touch pinch / swipe, keyboard shortcuts, voice commands ("zoom in", "next page", "minimize", "close") and optional webcam hand gestures (processed locally in the browser). |

## Accuracy policy

Zayed never guesses. Every answer is one of:

- **Verified** — grounded in an approved ADCMC source, with a citation to the document, section and approver.
- **From your file** — grounded in a document you uploaded in this session (clearly labelled as not ADCMC-verified).
- **Not verified** — no approved source covers the question; Zayed says so and points to the responsible department.

With a language model configured (Azure OpenAI or OpenAI) Zayed composes answers strictly from retrieved passages.
Without one, it quotes the most relevant approved passage verbatim, or refuses.

> This repository ships only the Zayed user guide as example knowledge. **No ADCMC facts are bundled.** Add approved
> ADCMC documents as described in [`knowledge/README.md`](knowledge/README.md).

## Getting started

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
cp .env.example .env               # then fill in the keys you have
python server.py                   # http://localhost:8000
```

There is no frontend build step — the static app in `static/` is served by FastAPI and loads Three.js, TalkingHead,
PDF.js, DOMPurify, MediaPipe and the Azure Speech SDK from CDNs.

### Configuration (`.env`)

| Variable | Purpose |
| --- | --- |
| `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | Voice output, lip-sync visemes and speech recognition. Without them Zayed answers in text only and uses browser speech recognition when available. |
| `ZAYED_VOICE_EN`, `ZAYED_VOICE_AR` | Optional Azure neural voice overrides. |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` | Preferred language model. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Alternative language model (used when Azure OpenAI is not configured). |
| `ZAYED_KNOWLEDGE_DIR`, `ZAYED_UPLOAD_DIR`, `ZAYED_MAX_UPLOAD_MB` | Knowledge and upload locations, upload limit (default 25 MB). |
| `ZAYED_AVATAR_URL`, `ZAYED_AVATAR_BODY` | Avatar GLB (must include ARKit + Oculus viseme blend shapes) and body type (`M` / `F`). |

Secrets stay on the server: the browser only receives short-lived Azure Speech tokens.

## Adding approved ADCMC knowledge

1. Place the source file (PDF, DOCX, PPTX, XLSX, CSV, MD or TXT) under `knowledge/`.
2. Add an entry to `knowledge/manifest.json` with `id`, `title`, `file`, `source`, `owner`, `approved_by`,
   `approved_on` and `status: "approved"` (optional: `title_ar`, `language`, `version`, `classification`).
3. Restart the server. Rejected entries (missing metadata, non-approved status, missing file, path outside
   `knowledge/`, duplicate id) are logged and reported in `/api/config`.

## Controls

| Action | Mouse / keyboard | Touch | Voice | Hand gesture (camera on) |
| --- | --- | --- | --- | --- |
| Zoom | Ctrl + wheel, `+` / `-`, `0` to fit | Pinch | "zoom in" / "zoom out" | Two open hands apart / together |
| Pan / scroll | Drag, wheel, arrow keys | Drag | "scroll down" / "scroll up" | Pinch and move / point |
| Next / previous | `←` `→`, PageUp / PageDown | Swipe | "next page" / "previous slide" | Open-palm swipe |
| Minimize / restore | Title bar button, Esc, dock | Tap | "minimize" / "restore the document" | Closed fist / thumbs up |
| Close | Title bar button | Tap | "close" | Thumbs down |

## API

| Method & path | Description |
| --- | --- |
| `POST /api/chat` | `{session_id, message, file_ids, language}` → `{answer, language, grounded, mode, sources, action}` |
| `GET /api/speech/token` | Short-lived Azure Speech token for browser recognition |
| `POST /api/speech/synthesize` | `{text, language}` → `{audio_base64, visemes, words}` |
| `POST /api/files` | Multipart upload (`file`, `session_id`) |
| `GET/DELETE /api/files/{id}`, `GET /api/files/{id}/raw`, `GET /api/files/{id}/assets/{n}` | Uploaded file metadata / preview, original file, extracted images |
| `GET /api/knowledge`, `GET /api/knowledge/{id}`, `.../raw`, `.../assets/{n}` | Approved documents |
| `GET /api/config`, `GET /healthz` | Capabilities and health |

## Project structure

```
server.py               FastAPI app and routes
zayed/config.py         Environment settings
zayed/text.py           Arabic / English normalisation, tokenisation, language detection
zayed/documents.py      Extraction and previews for PDF, DOCX, PPTX, XLSX/CSV, images, text
zayed/knowledge.py      Manifest-governed knowledge base + BM25 retrieval
zayed/files.py          Session-scoped upload store
zayed/assistant.py      Grounded answering and refusal policy
zayed/speech.py         Azure Speech synthesis (visemes, word timings) and tokens
knowledge/              manifest.json and approved source documents
static/index.html       App shell
static/css/zayed.css    Executive dark navy / cyan theme
static/js/              app, portrait (talking portrait), avatar (TalkingHead .glb), voice, workspace, gestures, i18n, api, icons
static/avatar/          zayed.webp + zayed.json talking-portrait asset
tools/build_portrait.py Offline builder for the portrait asset
tests/                  pytest suite
```

## Development

```bash
ruff check . && ruff format --check zayed server.py tests
pytest
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for coding standards.

### Changing the avatar

`ZAYED_AVATAR_URL` selects the renderer: a `.json` path loads the talking portrait, a `.glb` path loads a
TalkingHead 3D model (keep TalkingHead / ARKit blend-shape naming intact). To rebuild the portrait from a new
front-facing head-and-shoulders photo:

```bash
pip install mediapipe==0.10.14 rembg==2.0.59 opencv-python-headless scipy
python tools/build_portrait.py photo.png --crop X,Y,SIDE --out static/avatar/zayed
```

## License

[MIT](LICENSE)
