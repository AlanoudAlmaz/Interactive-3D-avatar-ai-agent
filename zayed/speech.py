"""Azure Speech: neural TTS with viseme timing, and short-lived STT tokens for the browser."""

import base64
import html
import logging
import re
import threading
import time

import azure.cognitiveservices.speech as speechsdk
import requests

from .config import Settings

logger = logging.getLogger("zayed.speech")

_MARKDOWN = re.compile(r"[*_`#>|]+")
_CITATION = re.compile(r"\[(?:S|U)\d+\]")
_URL = re.compile(r"https?://\S+")


def speakable(text: str) -> str:
    """Strip citations, URLs and Markdown so the voice reads clean sentences."""
    text = _CITATION.sub("", text)
    text = _URL.sub("", text)
    text = _MARKDOWN.sub("", text)
    text = re.sub(r"^\s*[-•]\s+", "", text, flags=re.MULTILINE)
    return re.sub(r"\s+", " ", text).strip()


class SpeechService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._token: tuple[str, float] | None = None
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self.settings.azure_speech_enabled

    def voice_for(self, language: str) -> str:
        return self.settings.voice_ar if language == "ar" else self.settings.voice_en

    def token(self) -> str:
        """Return a cached Azure STS token (valid 10 minutes, refreshed after 8)."""
        with self._lock:
            if self._token and time.time() - self._token[1] < 480:
                return self._token[0]
            response = requests.post(
                f"https://{self.settings.azure_speech_region}.api.cognitive.microsoft.com/sts/v1.0/issueToken",
                headers={"Ocp-Apim-Subscription-Key": self.settings.azure_speech_key},
                timeout=10,
            )
            response.raise_for_status()
            self._token = (response.text, time.time())
            return response.text

    def synthesize(self, text: str, language: str) -> dict:
        """Synthesize speech and collect Azure viseme IDs and word boundaries (ms offsets)."""
        spoken = speakable(text)
        if not spoken:
            raise ValueError("Nothing to speak.")
        config = speechsdk.SpeechConfig(
            subscription=self.settings.azure_speech_key, region=self.settings.azure_speech_region
        )
        config.set_speech_synthesis_output_format(speechsdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3)
        synthesizer = speechsdk.SpeechSynthesizer(speech_config=config, audio_config=None)

        visemes: list[dict] = []
        words: list[dict] = []

        def on_viseme(evt):
            visemes.append({"id": evt.viseme_id, "t": evt.audio_offset / 10000})

        def on_word(evt):
            if evt.boundary_type == speechsdk.SpeechSynthesisBoundaryType.Word:
                words.append(
                    {"text": evt.text, "t": evt.audio_offset / 10000, "d": evt.duration.total_seconds() * 1000}
                )
            elif evt.boundary_type == speechsdk.SpeechSynthesisBoundaryType.Punctuation and words:
                words[-1]["text"] += evt.text

        synthesizer.viseme_received.connect(on_viseme)
        synthesizer.synthesis_word_boundary.connect(on_word)

        voice = self.voice_for(language)
        locale = "-".join(voice.split("-")[:2])
        ssml = (
            "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' "
            f"xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='{locale}'>"
            f"<voice name='{voice}'><prosody rate='-4%'>{html.escape(spoken)}</prosody></voice></speak>"
        )
        result = synthesizer.speak_ssml_async(ssml).get()
        if result.reason != speechsdk.ResultReason.SynthesizingAudioCompleted:
            details = result.cancellation_details
            reason = details.error_details if details else str(result.reason)
            logger.error("Azure TTS failed: %s", reason)
            raise RuntimeError("Azure speech synthesis failed.")
        return {
            "audio_base64": base64.b64encode(result.audio_data).decode("ascii"),
            "mime": "audio/mpeg",
            "visemes": visemes,
            "words": words,
            "voice": voice,
        }
