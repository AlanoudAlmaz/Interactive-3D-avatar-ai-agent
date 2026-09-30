import * as THREE from "three";
import { TalkingHead } from "talkinghead";

// Azure Speech viseme IDs (0-21) mapped to the Oculus viseme set used by TalkingHead.
const AZURE_TO_OCULUS = [
  "sil", "aa", "aa", "O", "E", "RR", "I", "U", "O", "aa", "O",
  "aa", "kk", "RR", "nn", "SS", "CH", "TH", "FF", "DD", "kk", "PP",
];

export class Avatar {
  constructor(node, { url, body }) {
    this.node = node;
    this.url = url;
    this.body = body;
    this.head = null;
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.speakingUntil = 0;
    this.endTimer = null;
    this.onEnd = null;
  }

  async load(onProgress) {
    this.head = new TalkingHead(this.node, {
      modelRoot: "Armature",
      cameraView: "head",
      cameraDistance: 0.55,
      cameraY: 0,
      cameraRotateEnable: false,
      lipsyncModules: ["en"],
      lipsyncLang: "en",
      audioCtx: this.audioCtx,
      ttsVolume: 1.0,
      mixerGainSpeech: 1.0,
      avatarIdleEyeContact: 0.6,
      avatarSpeakingEyeContact: 0.8,
      avatarIdleHeadMove: 0.25,
      avatarSpeakingHeadMove: 0.45,
      lightAmbientColor: 0xbfe8ff,
      lightAmbientIntensity: 1.6,
      lightDirectColor: 0x9fe6ff,
      lightDirectIntensity: 22,
      lightSpotColor: 0x3fd2ff,
      lightSpotIntensity: 6,
      lightSpotPhi: 0.1,
      lightSpotTheta: 4,
      modelPixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    });
    await this.head.showAvatar(
      { url: this.url, body: this.body, avatarMood: "neutral", lipsyncLang: "en" },
      (ev) => ev.lengthComputable && onProgress?.(ev.loaded / ev.total),
    );
    this.#tint();
  }

  #tint() {
    const rim = new THREE.Color(0x0d3f52);
    this.head.armature?.traverse((obj) => {
      if (!obj.isMesh) return;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      materials.forEach((m) => {
        if (m && "emissive" in m) {
          m.emissive = rim.clone();
          m.emissiveIntensity = 0.35;
          m.needsUpdate = true;
        }
      });
    });
  }

  async resume() {
    if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
  }

  get speaking() {
    return performance.now() < this.speakingUntil;
  }

  /** Play Azure Speech audio with viseme-driven lip-sync. Resolves when playback ends or is stopped. */
  async speak({ audio_base64, visemes = [], words = [] }) {
    await this.resume();
    const bytes = Uint8Array.from(atob(audio_base64), (c) => c.charCodeAt(0));
    const buffer = await this.audioCtx.decodeAudioData(bytes.buffer);
    const vis = [], vtimes = [], vdurations = [];
    visemes.forEach((v, i) => {
      const next = visemes[i + 1]?.t ?? buffer.duration * 1000;
      vis.push(AZURE_TO_OCULUS[v.id] || "sil");
      vtimes.push(v.t);
      vdurations.push(Math.max(40, next - v.t));
    });
    this.stop();
    this.head.speakAudio(
      {
        audio: buffer,
        words: words.map((w) => w.text),
        wtimes: words.map((w) => w.t),
        wdurations: words.map((w) => w.d),
        visemes: vis,
        vtimes,
        vdurations,
      },
      { lipsyncLang: "en" },
    );
    this.speakingUntil = performance.now() + buffer.duration * 1000 + 150;
    return new Promise((resolve) => {
      this.onEnd = resolve;
      this.endTimer = setTimeout(() => this.#finish(), buffer.duration * 1000 + 150);
    });
  }

  #finish() {
    clearTimeout(this.endTimer);
    this.speakingUntil = 0;
    const done = this.onEnd;
    this.onEnd = null;
    done?.();
  }

  stop() {
    if (this.head && this.speaking) this.head.stopSpeaking();
    this.#finish();
  }

  setMood(mood) {
    try {
      this.head?.setMood(mood);
    } catch {
      /* mood unsupported by this model */
    }
  }

  lookAtUser() {
    this.head?.lookAtCamera?.(600);
  }
}
