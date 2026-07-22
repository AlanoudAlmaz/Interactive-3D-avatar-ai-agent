<div align="center">

#  Riverborn AI — 3D Voice Agent

**A production-ready, real-time 3D AI voice agent with high-fidelity lip-sync powered by Azure Cognitive Services, OpenAI GPT-4o, and Deepgram.**

[![Python](https://img.shields.io/badge/Python-3.8%2B-3776ab?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.104-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)]()

</div>

---

##  What Is This?

**Riverborn AI** is a full-stack, open-source voice agent that lets you have a real-time, natural conversation with a photorealistic 3D avatar directly in your browser. You speak → the avatar hears you → thinks using GPT-4o → responds with a human-like voice → and its **mouth moves in perfect sync with what it says**.

No push-to-talk buttons. No command keywords. Just talk.

### Live Demo Flow

```
🎤 You speak  →  🧠 Deepgram transcribes  →  💡 GPT-4o reasons  →  🗣️ Azure speaks + generates lip data  →  👄 3D avatar lip-syncs
```

---

##  Key Features

| Feature | Description |
|---|---|
| 🗣️ **Continuous Listening** | Auto-detects voice activity using an audio analyser. No button needed. |
| 👤 **3D Avatar (GLB)** | Photorealistic `.glb` model rendered with `three.js` via the `TalkingHead` library. |
| 👄 **ARKit Lip-Sync** | Azure Speech returns 55 ARKit blendshape values per frame — applied directly to the 3D mesh in real-time. |
| ⚡ **Ultra-Fast STT** | Deepgram Nova-2 transcribes your voice with near-zero latency. |
| 🧠 **GPT-4o Brain** | Multi-turn conversation memory. The agent remembers the entire conversation session. |
| 🔊 **Neural TTS** | Azure's `en-US-AvaMultilingualNeural` voice. Falls back to OpenAI TTS if Azure is unavailable. |
| 🎨 **Premium Dark UI** | Glassmorphism dashboard built with Tailwind CSS + custom CSS. Fully responsive. |

---

##  System Architecture

Understanding how all the pieces fit together is important before you start:

```
┌─────────────────────────────────────────────────────────┐
│                    BROWSER (Frontend)                    │
│                                                          │
│  ┌──────────────┐    ┌──────────────┐   ┌────────────┐  │
│  │  Microphone  │    │  3D Avatar   │   │  Transcript│  │
│  │  (WebAudio   │    │  (three.js + │   │  Panel     │  │
│  │   Analyser)  │    │  TalkingHead)│   │  (Chat log)│  │
│  └──────┬───────┘    └──────▲───────┘   └────────────┘  │
│         │ WAV audio          │ blendshapes + audio        │
└─────────┼────────────────────┼───────────────────────────┘
          │ POST /process-voice│
          ▼                    │
┌─────────────────────────────────────────────────────────┐
│                  PYTHON BACKEND (FastAPI)                │
│                                                          │
│   1. Receives WAV  ──▶  2. Deepgram STT                 │
│                              │ transcript text            │
│                              ▼                           │
│                     3. OpenAI GPT-4o                     │
│                              │ AI reply text              │
│                              ▼                           │
│                     4. Azure TTS + Visemes               │
│                              │ audio (MP3) + blendshapes  │
│                              ▼                           │
│                     5. Return JSON response ─────────────┘
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Data Flow Explained

1. **Audio Capture**: The browser's `MediaRecorder` captures your voice as a WAV blob. An `AudioAnalyser` monitors volume levels to detect when you've stopped speaking (silence detection).
2. **Transcription**: The WAV is sent to **Deepgram Nova-2** which returns a text transcript with very low latency.
3. **Reasoning**: The transcript is appended to a multi-turn `conversation_history` list and sent to **OpenAI GPT-4o** for a response.
4. **Speech Synthesis**: The AI's text response is sent to **Azure Cognitive Speech Services** using SSML with `<mstts:viseme type="FacialExpression"/>`. This causes Azure to return **both the audio and a stream of ARKit blendshape data** (55 float values per frame, ~60 times per second).
5. **3D Lip-Sync**: The browser receives the base64 audio and the `visemes` array. It plays the audio through the Web Audio API while an `requestAnimationFrame` loop applies the blendshape values to the correct morph targets on the 3D mesh in real-time.

---

## 📁 Project Structure

```
voice-agent/
│
├── server.py                  # 🖥️  FastAPI backend — main orchestration file
├── agent.py                   # 🖥️  (Optional) CLI-only voice agent (no avatar)
│
├── static/
│   ├── index.html             # 🌐  Full frontend: UI + 3D avatar + all JavaScript logic
│   ├── blendshapes.js         # 🗂️  ARKit blendshape name-to-index mapping (55 names)
│   └── avatar_fixed.glb       # 👤  3D avatar model (you must provide your own — see below)
│
├── requirements.txt           # 📦  Python dependencies
├── .env.example               # 🔑  Template for your API keys
├── .env                       # 🔒  Your actual API keys (gitignored — never commit this!)
├── .gitignore                 # 🚫  Excludes venv, .env, cache, etc.
└── README.md                  # 📖  This file
```

### Key Files Explained

| File | Role |
|---|---|
| `server.py` | The heart of the backend. Handles 3 endpoints: serve the UI (`/`), process voice (`/process-voice`), and calls all 3rd-party APIs. |
| `static/index.html` | Everything frontend lives here: CSS design system, HTML layout, and all JavaScript (avatar init, mic capture, lip-sync animation loop). |
| `static/blendshapes.js` | Exports an ordered array of the 55 ARKit blendshape names. This order matches exactly what Azure returns. Used to map Azure's data to the correct morph targets on the GLB model. |
| `agent.py` | A simpler, CLI-only version of the agent. Useful for testing the STT/LLM/TTS pipeline without the 3D avatar. Requires a physical microphone connected to your machine. |

---

##  Getting Started

### Prerequisites

Before you begin, make sure you have:

- **Python 3.8+** installed
- **pip** (Python package manager)
- API keys for the following services (all have free tiers):
  - [OpenAI](https://platform.openai.com/api-keys) — for GPT-4o (brain)
  - [Deepgram](https://console.deepgram.com/) — for speech-to-text
  - [Azure Cognitive Services](https://portal.azure.com/) — for TTS + lip-sync data *(most important)*
- A compatible **3D avatar** in `.glb` format (see the [Avatar Guide](#-avatar-guide) below)

---

### Step 1: Clone the Repository

```bash
git clone https://github.com/YOUR_USERNAME/riverborn-ai-agent.git
cd riverborn-ai-agent
```

---

### Step 2: Create a Virtual Environment

It's strongly recommended to use a virtual environment to avoid dependency conflicts.

```bash
# Create the environment
python -m venv venv

# Activate it
# On macOS / Linux:
source venv/bin/activate

# On Windows:
venv\Scripts\activate
```

---

### Step 3: Install Dependencies

```bash
pip install -r requirements.txt
```

**What gets installed:**
| Package | Purpose |
|---|---|
| `fastapi` | High-performance web framework for the backend API |
| `uvicorn` | ASGI server to run FastAPI |
| `python-multipart` | Required by FastAPI to accept file uploads (the audio WAV) |
| `openai` | Official Python SDK for GPT-4o and fallback TTS |
| `elevenlabs` | SDK for ElevenLabs (optional alternative TTS) |
| `python-dotenv` | Loads API keys from your `.env` file |
| `azure-cognitiveservices-speech` | Azure SDK — handles TTS audio + ARKit blendshape generation |
| `requests` | HTTP client for Deepgram API calls |

---

### Step 4: Configure Your API Keys

Copy the example environment file and fill in your keys:

```bash
cp .env.example .env
```

Now open `.env` in a text editor and fill in your credentials:

```env
# OpenAI — used for GPT-4o responses and fallback TTS
OPENAI_API_KEY=sk-...

# Deepgram — used for ultra-fast speech-to-text transcription
DEEPGRAM_API_KEY=...

# Azure Speech Service — used for neural TTS AND lip-sync blendshape data
# ⚠️ This is the most critical key. Without it, lip-sync will not work.
AZURE_SPEECH_KEY=...
AZURE_SPEECH_REGION=eastus   # Change to match your Azure resource region

# Optional: ElevenLabs — alternative high-quality TTS (not used by default)
ELEVENLABS_API_KEY=
```

> **How to get Azure keys:**
> 1. Go to [portal.azure.com](https://portal.azure.com)
> 2. Create a resource → Search "Speech" → Create "Speech service"
> 3. After creation, go to the resource → **Keys and Endpoint**
> 4. Copy **Key 1** and the **Location/Region**

---

### Step 5: Add Your Avatar Model

You need to place a compatible `.glb` file at `static/avatar_fixed.glb`. See the **[Avatar Guide](#-avatar-guide)** section below for details on where to get a compatible model.

---

### Step 6: Run the Server

```bash
uvicorn server:app --host 0.0.0.0 --port 8000
```

Or equivalently:
```bash
python server.py
```

---

### Step 7: Open the App

Open your browser and go to:

```
http://localhost:8000
```

You will see the "Digital Human Interface" splash screen. Click **"Launch Neural Agent"** to:
1. Initialize the 3D avatar (loads the `.glb` model)
2. Request microphone permission
3. Automatically begin listening for your voice

---

##  How to Use

1. **Click "Launch Neural Agent"** to start the app and grant mic access.
2. **Talk naturally** — the system will detect when you start and stop speaking automatically.
3. **Watch the transcript panel** (right side) to see what you said and what the AI responded.
4. **Watch the avatar** lip-sync in real-time as it speaks back to you.
5. After the avatar finishes speaking, it will **automatically start listening again**.

> **Tip:** The silence detection threshold is `avg > 3` (audio amplitude). If the mic is too sensitive or not sensitive enough in a noisy environment, you can adjust the `SILENCE_DELAY` constant (line ~501 in `index.html`) or the threshold value.

---

##  Deploying to Render

You can easily deploy this 3D Voice Agent to **[Render](https://render.com/)** as a Web Service.

### Why Render?
To use the microphone in a web browser, modern security standards require a **Secure Context (HTTPS)**. Render automatically provisions an SSL/TLS certificate (`https://your-app.onrender.com`) for your deployment, allowing the microphone and voice activity detection to work perfectly!

### Step-by-Step Deployment:

1. **Push your code to GitHub** (make sure `.env` is ignored!).
2. Create a new **Web Service** on Render and connect your GitHub repository.
3. Configure the following settings:
   - **Runtime:** `Python 3` (or standard Python environment)
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `python server.py` (The server is pre-configured to bind dynamically to Render's allocated `$PORT`).
4. Under **Advanced**, add the following **Environment Variables**:
   - `OPENAI_API_KEY`: Your OpenAI API key.
   - `DEEPGRAM_API_KEY`: Your Deepgram API key.
   - `AZURE_SPEECH_KEY`: Your Azure Speech Service key.
   - `AZURE_SPEECH_REGION`: Your Azure resource region (e.g., `eastus`).
5. Click **Deploy Web Service**.

> ⚠️ **Note on Avatars:** Since `static/avatar_fixed.glb` is ignored by Git, you will need to either upload your avatar to a public URL (e.g. Cloudflare R2, AWS S3) and update the path in `index.html`, OR temporarily commit a lightweight `.glb` avatar to your private repo before deploying.

---


##  Avatar Guide

The `avatar_fixed.glb` model is **not included** in this repository due to file size. You need to provide your own.

### Requirements for a Compatible Avatar

Your `.glb` model **must have ARKit blendshapes** (also called "morph targets") with names matching the standard ARKit face rig. The 55 expected blendshape names are listed in `static/blendshapes.js`.

### Recommended Sources

1. **[ReadyPlayerMe](https://readyplayer.me/)** (Free)
   - Create a free avatar. Download as `.glb`.
   - ✅ Has ARKit blendshapes by default. Works out of the box.

2. **[TalkingHead Demo Models](https://github.com/met4citizen/TalkingHead)** (MIT License)
   - The library author provides several compatible `.glb` avatars.
   - Check the `assets/` folder in the TalkingHead GitHub repo.

3. **[Sketchfab](https://sketchfab.com/)** (Various licenses)
   - Search for "ARKit face rig glb". Check for morph targets.

### After Getting a Model

Place the file at:
```
static/avatar_fixed.glb
```

If your model's root bone/armature has a different name (not `Armature`), update this line in `index.html`:
```javascript
head = new TalkingHead(node, {
    modelRoot: "Armature",  // ← Change this to match your model's root node name
    ...
});
```

---

## 🔧 Customization Guide

### Changing the AI Persona / System Prompt

In `server.py`, find the `conversation_history` list and modify the `system` message:

```python
conversation_history = [
    {
        "role": "system",
        "content": "You are a friendly customer support agent for Acme Corp. Be helpful, brief, and professional."
    }
]
```

### Changing the Avatar's Voice

In `server.py`, find the SSML string inside `generate_azure_tts_with_visemes()`:

```python
ssml = f"""
<speak ...>
    <voice name='en-US-AvaMultilingualNeural'>  <!-- ← Change voice here -->
        ...
    </voice>
</speak>
"""
```

See the full list of Azure Neural voices at [Microsoft's voice gallery](https://speech.microsoft.com/portal/voicegallery).

### Tuning the Lip-Sync Intensity

In `static/index.html`, find the `WEIGHTS` object inside the `speakResponse` function:

```javascript
const WEIGHTS = {
    17: 0.18,  // jawOpen        — main mouth open (higher = wider)
    18: 0.70,  // mouthClose     — lip press for p/b/m sounds
    19: 0.30,  // mouthFunnel    — O/oo shape
    20: 0.30,  // mouthPucker    — pursed lips
    37: 0.22,  // mouthLowerDownLeft
    38: 0.22,  // mouthLowerDownRight
    39: 0.20,  // mouthUpperUpLeft  — controls gum visibility (keep ≤ 0.22)
    40: 0.20,  // mouthUpperUpRight
};
```

- **Increase `17` (jawOpen)** to open the mouth wider during speech.
- **Decrease `39` and `40`** if you see too much gum/teeth.
- Adding more blendshape indices here will enable more facial movement.

### Using the CLI Agent (No Avatar)

If you want to test the raw speech-to-text, reasoning, and ElevenLabs voice synthesis pipeline directly in your terminal (no web browser or 3D avatar), you can use the CLI agent:

```bash
python agent.py
```

>  **Prerequisites for CLI Agent:**
> The CLI agent requires a local physical microphone and the following packages:
> - `SpeechRecognition` (`pip install SpeechRecognition`)
> - `PyAudio` (`pip install PyAudio`)
>
> *Note for macOS users:* If installing `PyAudio` fails, you may need to install the audio framework system library first via Homebrew:
> ```bash
> brew install portaudio
> pip install pyaudio
> ```


### Changing the LLM Model

In `server.py`:

```python
response = openai_client.chat.completions.create(
    model="gpt-4o",   # ← Change to "gpt-4o-mini" to reduce cost
    messages=conversation_history,
    max_tokens=200    # ← Adjust response length
)
```

---

##  Security Notes

- **Never commit your `.env` file.** It is listed in `.gitignore` to prevent accidental exposure.
- The `.env.example` file is safe to commit — it contains no real keys.
- For production deployment, use environment variables from your hosting platform (e.g., Railway, Render, Heroku) instead of a `.env` file.
- The `conversation_history` is stored **in memory** on the server (a Python list). It is shared across all browser tabs and resets when the server restarts. For a multi-user production system, you'd want to store this in a database with session IDs.

---

##  Troubleshooting

| Problem | Likely Cause & Fix |
|---|---|
| `Avatar Load Error` in browser | The `static/avatar_fixed.glb` file is missing. Add a compatible GLB file. |
| `Mic Error` in browser | Microphone permission denied. Allow mic access in your browser's address bar settings. Ensure you're on `localhost` or `https` (WebRTC requires a secure context). |
| Mouth doesn't move (lip-sync broken) | `AZURE_SPEECH_KEY` is missing or wrong. Check your `.env`. The fallback (volume-based) animation will be used instead. |
| `No speech detected` after talking | The silence detection threshold may be too low for your microphone. Try speaking louder, or adjust the threshold on line ~511 in `index.html`. |
| 500 error on `/process-voice` | Check the server terminal logs. Usually a missing API key or an API quota exceeded error. |
| Avatar body looks distorted | Your GLB model's root bone name doesn't match. Change `modelRoot: "Armature"` in `index.html` to match your model. |

---

##  Tech Stack

| Layer | Technology | Why |
|---|---|---|
| **Frontend** | HTML5, CSS3, Vanilla JS, Tailwind CSS | Lightweight, no build step needed |
| **3D Rendering** | [three.js](https://threejs.org/) | Industry standard WebGL 3D library |
| **Avatar Animation** | [TalkingHead.js](https://github.com/met4citizen/TalkingHead) | High-quality, open-source 3D facial animation |
| **Backend** | [FastAPI](https://fastapi.tiangolo.com/) (Python) | Fast async API with auto-generated docs at `/docs` |
| **STT** | [Deepgram Nova-2](https://deepgram.com/) | Best-in-class accuracy and speed for real-time transcription |
| **LLM** | [OpenAI GPT-4o](https://openai.com/) | Multi-turn conversation with context |
| **TTS + Lip-Sync** | [Azure Cognitive Speech](https://azure.microsoft.com/en-us/products/ai-services/ai-speech) | The only mainstream TTS service that returns ARKit blendshape data |

---

##  Contributing

Contributions are what make the open-source community such an amazing place to learn, inspire, and create! Any contributions you make are **greatly appreciated**.

Please refer to [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines on setting up your local environment, coding style standards, and the pull request submission process.

To get started quickly:
1. **Fork** the repository.
2. **Create a branch**: `git checkout -b feature/my-new-feature`.
3. **Commit your changes**: `git commit -m 'feat: Add some awesome feature'`.
4. **Push to the branch**: `git push origin feature/my-new-feature`.
5. **Open a Pull Request**.


---

##  License

This project is open-source under the [MIT License](LICENSE). You are free to use, modify, and distribute it.

---

<div align="center">
Made with ❤️ | Star ⭐ this repo if you found it useful!
</div>
