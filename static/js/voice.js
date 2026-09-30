import { api } from "./api.js";

const LOCALES = { en: "en-US", ar: "ar-AE" };

/** Speech-to-text: Azure Speech (auto-detects Arabic/English) with the browser Web Speech API as fallback. */
export class VoiceInput {
  constructor() {
    this.azure = false;
    this.token = null;
    this.tokenAt = 0;
    this.region = null;
    this.active = null;
  }

  configure({ azure }) {
    this.azure = Boolean(azure);
  }

  get available() {
    return (this.azure && window.SpeechSDK) || Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  get listening() {
    return Boolean(this.active);
  }

  async #azureToken() {
    if (!this.token || Date.now() - this.tokenAt > 8 * 60 * 1000) {
      const { token, region } = await api.speechToken();
      this.token = token;
      this.region = region;
      this.tokenAt = Date.now();
    }
    return this.token;
  }

  /** Listen for one utterance. Resolves {text, language, detected} or null when nothing was recognised. */
  async listen({ lang, onPartial }) {
    this.cancel();
    if (this.azure && window.SpeechSDK) {
      try {
        return await this.#listenAzure(lang, onPartial);
      } catch (err) {
        if (err?.name === "NotAllowedError") throw err;
        if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) throw err;
      }
    }
    return this.#listenBrowser(lang, onPartial);
  }

  async #listenAzure(lang, onPartial) {
    const sdk = window.SpeechSDK;
    const token = await this.#azureToken();
    const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(token, this.region);
    speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, "900");
    const languages = lang === "ar" ? ["ar-AE", "en-US"] : ["en-US", "ar-AE"];
    const autoDetect = sdk.AutoDetectSourceLanguageConfig.fromLanguages(languages);
    const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
    const recognizer = sdk.SpeechRecognizer.FromConfig(speechConfig, autoDetect, audioConfig);
    recognizer.recognizing = (_s, e) => onPartial?.(e.result.text);
    return new Promise((resolve, reject) => {
      const finish = (value, error) => {
        this.active = null;
        recognizer.close();
        error ? reject(error) : resolve(value);
      };
      this.active = { cancel: () => finish(null) };
      recognizer.recognizeOnceAsync(
        (result) => {
          if (result.reason !== sdk.ResultReason.RecognizedSpeech || !result.text) return finish(null);
          const detected = sdk.AutoDetectSourceLanguageResult.fromResult(result).language || languages[0];
          finish({ text: result.text, language: detected.startsWith("ar") ? "ar" : "en", detected: true });
        },
        (error) => finish(null, new Error(String(error))),
      );
    });
  }

  #listenBrowser(lang, onPartial) {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return Promise.reject(new Error("unavailable"));
    const recognition = new Recognition();
    recognition.lang = LOCALES[lang] || "en-US";
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    return new Promise((resolve, reject) => {
      let finalText = "";
      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        this.active = null;
        error ? reject(error) : resolve(value);
      };
      this.active = {
        cancel: () => {
          recognition.abort();
          finish(null);
        },
      };
      recognition.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        onPartial?.(finalText + interim);
      };
      recognition.onerror = (event) => {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          const err = new Error("denied");
          err.name = "NotAllowedError";
          finish(null, err);
        } else {
          finish(null);
        }
      };
      recognition.onend = () => finish(finalText.trim() ? { text: finalText.trim(), language: lang } : null);
      recognition.start();
    });
  }

  cancel() {
    this.active?.cancel();
    this.active = null;
  }
}
