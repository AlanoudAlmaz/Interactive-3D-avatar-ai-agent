import { api } from "./api.js";
import { HandGestures } from "./gestures.js";
import { lang, onLangChange, setLang, t } from "./i18n.js";
import { icon, kindIcon } from "./icons.js";
import { VoiceInput } from "./voice.js";
import { Workspace } from "./workspace.js";

const $ = (id) => document.getElementById(id);
const els = {
  holo: $("holo"), avatar: $("avatar"), fallback: $("avatarFallback"),
  state: $("state"), stateLabel: $("stateLabel"), caption: $("caption"), stageHint: $("stageHint"),
  mic: $("micButton"), stop: $("stopButton"), messages: $("messages"), welcome: $("welcome"),
  suggestions: $("suggestions"), attachments: $("attachments"), composer: $("composer"), input: $("input"),
  send: $("sendButton"), attach: $("attachButton"), fileInput: $("fileInput"), composerMic: $("composerMic"),
  kbButton: $("kbButton"), kbLabel: $("kbLabel"), kbDrawer: $("kbDrawer"), kbList: $("kbList"),
  voiceToggle: $("voiceToggle"), statusButton: $("statusButton"), statusPopover: $("statusPopover"),
  langToggle: $("langToggle"), clear: $("clearChat"), drop: $("dropOverlay"), toasts: $("toasts"),
};

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const app = {
  config: null,
  knowledge: [],
  attachments: [],
  avatar: null,
  avatarReady: false,
  voiceOut: localStorage.getItem("zayed.voice") !== "off",
  busy: false,
  state: "loading",
};

const voice = new VoiceInput();
const workspace = new Workspace($("workspace"), $("dock"));
const gestures = new HandGestures($("workspace"), (command, arg) => workspace.command(command, arg));

// ---------- UI helpers ----------
function paintIcons() {
  document.querySelectorAll("[data-icon]").forEach((el) => (el.innerHTML = icon(el.dataset.icon, el.classList.contains("mic-icon") ? 24 : 16)));
  els.attach.innerHTML = icon("attach");
  els.composerMic.innerHTML = icon("mic");
  els.send.innerHTML = icon("send");
  els.statusButton.innerHTML = icon("info");
  els.kbDrawer.querySelector("[data-close]").innerHTML = icon("close");
  paintVoiceToggle();
}

function paintVoiceToggle() {
  const on = app.voiceOut && app.config?.capabilities.azure_speech;
  els.voiceToggle.innerHTML = icon(on ? "volume" : "mute");
  els.voiceToggle.dataset.i18nTitle = on ? "voiceOn" : "voiceOff";
  els.voiceToggle.title = t(els.voiceToggle.dataset.i18nTitle);
  els.voiceToggle.setAttribute("aria-label", els.voiceToggle.title);
  els.voiceToggle.disabled = !app.config?.capabilities.azure_speech;
}

function setState(state) {
  app.state = state;
  els.state.dataset.state = state;
  els.holo.dataset.state = state;
  els.stateLabel.dataset.i18n = `state_${state}`;
  els.stateLabel.textContent = t(`state_${state}`);
  const listening = state === "listening";
  els.mic.classList.toggle("listening", listening);
  els.composerMic.classList.toggle("active", listening);
  els.stop.hidden = state !== "speaking";
  els.stageHint.hidden = state !== "ready";
}

function setCaption(text, partial = false) {
  els.caption.textContent = text || "";
  els.caption.classList.toggle("partial", partial);
}

function toast(message, type = "info") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  els.toasts.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function scrollMessages() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderSuggestions() {
  els.suggestions.innerHTML = "";
  t("suggestions").forEach((text) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggestion";
    btn.textContent = text;
    btn.addEventListener("click", () => ask(text));
    els.suggestions.appendChild(btn);
  });
}

// ---------- Messages ----------
function addUserMessage(text) {
  els.welcome.hidden = true;
  const node = document.createElement("div");
  node.className = "msg user";
  node.innerHTML = `<div class="bubble" dir="auto"></div>`;
  node.querySelector(".bubble").textContent = text;
  els.messages.appendChild(node);
  scrollMessages();
}

function addTyping() {
  const node = document.createElement("div");
  node.className = "msg assistant";
  node.innerHTML = '<div class="bubble typing"><i></i><i></i><i></i></div>';
  els.messages.appendChild(node);
  scrollMessages();
  return node;
}

function sourceTitle(source, language = lang()) {
  return language === "ar" && source.title_ar ? source.title_ar : source.title;
}

function addAssistantMessage(result) {
  const node = document.createElement("div");
  const refusal = !result.grounded;
  node.className = `msg assistant${refusal ? " refusal" : ""}`;
  const bySource = Object.fromEntries((result.sources || []).map((s) => [s.tag, s]));
  const body = escapeHtml(result.answer).replace(/\[([SU]\d+)\]/g, (m, tag) =>
    bySource[tag] ? `<button type="button" class="cite" data-tag="${tag}">${tag}</button>` : "",
  );
  const fromUpload = (result.sources || []).some((s) => s.origin === "upload");
  const fromKnowledge = (result.sources || []).some((s) => s.origin === "knowledge");
  let badge = "";
  if (result.mode !== "conversational") {
    if (refusal) badge = `<span class="badge warn">${icon("warn", 12)}${t("notVerified")}</span>`;
    else if (fromKnowledge) badge = `<span class="badge ok">${icon("shield", 12)}${t("verified")}</span>`;
    else if (fromUpload) badge = `<span class="badge info">${icon("doc", 12)}${t("fromUpload")}</span>`;
  }
  const sources = (result.sources || [])
    .map((s) => {
      const sub = s.origin === "knowledge"
        ? [s.section, s.approved_by && `${t("approvedBy")} ${s.approved_by}`, s.approved_on].filter(Boolean).join(" · ")
        : [t("uploaded"), s.section].filter(Boolean).join(" · ");
      return `<button type="button" class="source" data-tag="${s.tag}">
          <span class="source-tag">${s.tag}</span>
          <span class="source-body"><span class="source-title" dir="auto">${escapeHtml(sourceTitle(s, result.language))}</span>
          <span class="source-sub" dir="auto">${escapeHtml(sub)}</span></span>
        </button>`;
    })
    .join("");
  node.innerHTML = `
    <div class="bubble" dir="auto" lang="${result.language}">${body}</div>
    ${sources ? `<div class="sources">${sources}</div>` : ""}
    ${badge ? `<div class="msg-meta">${badge}</div>` : ""}`;
  node.querySelectorAll("[data-tag]").forEach((btn) =>
    btn.addEventListener("click", () => openSource(bySource[btn.dataset.tag])),
  );
  els.messages.appendChild(node);
  scrollMessages();
}

function addSystemNote(text) {
  addAssistantMessage({ answer: text, grounded: true, mode: "conversational", sources: [], language: lang() });
}

// ---------- Documents ----------
async function openSource(source) {
  if (!source) return;
  try {
    const doc = source.origin === "knowledge" ? await api.knowledgeDoc(source.id) : await api.file(source.id);
    workspace.open(doc, source.anchor);
  } catch {
    toast(t("networkError"), "error");
  }
}

function renderAttachments() {
  els.attachments.innerHTML = "";
  app.attachments.forEach((file) => {
    const chip = document.createElement("div");
    chip.className = `chip${file.pending ? " pending" : ""}`;
    chip.innerHTML = `${kindIcon(file.kind)}<button type="button" class="chip-name" dir="auto"></button>`;
    chip.querySelector(".chip-name").textContent = file.title;
    if (!file.pending) {
      chip.querySelector(".chip-name").addEventListener("click", () => workspace.open(file));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chip-x";
      remove.title = t("remove");
      remove.setAttribute("aria-label", `${t("remove")} ${file.title}`);
      remove.innerHTML = icon("close", 14);
      remove.addEventListener("click", () => removeAttachment(file));
      chip.appendChild(remove);
    }
    els.attachments.appendChild(chip);
  });
}

async function removeAttachment(file) {
  app.attachments = app.attachments.filter((f) => f !== file);
  workspace.closeByKey(`upload:${file.id}`);
  renderAttachments();
  try {
    await api.deleteFile(file.id);
  } catch {
    /* already expired */
  }
}

async function uploadFiles(fileList) {
  const allowed = new Set(app.config.upload.extensions);
  for (const file of fileList) {
    const ext = `.${file.name.split(".").pop().toLowerCase()}`;
    if (!allowed.has(ext)) {
      toast(`${t("uploadFailed")}: ${file.name}`, "error");
      continue;
    }
    if (file.size > app.config.upload.max_mb * 1024 * 1024) {
      toast(`${file.name}: ${t("tooLarge", app.config.upload.max_mb)}`, "error");
      continue;
    }
    const placeholder = { title: file.name, kind: "text", pending: true };
    app.attachments.push(placeholder);
    renderAttachments();
    try {
      const stored = await api.upload(file);
      Object.assign(placeholder, stored, { pending: false });
      renderAttachments();
      workspace.open(placeholder);
    } catch (err) {
      app.attachments = app.attachments.filter((f) => f !== placeholder);
      renderAttachments();
      toast(`${t("uploadFailed")}: ${err.message || file.name}`, "error");
    }
  }
}

// ---------- Voice commands for the document workspace ----------
const COMMANDS = [
  [/^(please )?(zoom in|enlarge|bigger)\b/, "zoomIn"],
  [/^(please )?(zoom out|smaller)\b/, "zoomOut"],
  [/^(fit|fit to (width|screen)|reset zoom)\b/, "fit"],
  [/^(next|next (page|slide|sheet)|go forward)\b/, "next"],
  [/^(previous|prev|back|go back|previous (page|slide|sheet))\b/, "prev"],
  [/^scroll down\b/, "scrollDown"],
  [/^scroll up\b/, "scrollUp"],
  [/^(minimi[sz]e|hide)( (the )?(document|file|window))?\b/, "minimize"],
  [/^(close)( (the )?(document|file|window))?\b/, "close"],
  [/^(restore|show)( (the )?(document|file|window))\b/, "restore"],
  [/^(صغر|تصغير) (النافذه|المستند|الملف)/, "minimize"],
  [/^(كبر|تكبير|قرب)/, "zoomIn"],
  [/^(صغر|تصغير|بعد)/, "zoomOut"],
  [/^(ملاءمه|ملائمه|مناسبه) (العرض|الشاشه)/, "fit"],
  [/^(الصفحه التاليه|الشريحه التاليه|التالي|التاليه)/, "next"],
  [/^(الصفحه السابقه|الشريحه السابقه|السابق|السابقه|ارجع)/, "prev"],
  [/^(مرر|انزل) (لاسفل|للاسفل|تحت)/, "scrollDown"],
  [/^(مرر|اطلع) (لاعلي|للاعلي|فوق)/, "scrollUp"],
  [/^(اغلق|سكر|اقفل)/, "close"],
  [/^(استعد|اعرض|افتح) (النافذه|المستند|الملف)/, "restore"],
];

function matchCommand(text) {
  const normalized = text
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[إأآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[.!?،؟]/g, "")
    .trim();
  if (normalized.split(/\s+/).length > 5) return null;
  return COMMANDS.find(([re]) => re.test(normalized))?.[1] || null;
}

// ---------- Conversation ----------
async function speak(text, language) {
  if (!app.voiceOut || !app.config.capabilities.azure_speech || !app.avatarReady || !text) return;
  try {
    const speech = await api.synthesize(text.slice(0, 3000), language);
    setState("speaking");
    await app.avatar.speak(speech);
  } catch {
    /* voice is best-effort; the text answer is already shown */
  }
}

async function ask(text, { language } = {}) {
  text = text.trim();
  if (!text || app.busy) return;
  const hasWindows = workspace.windows.length > 0;
  const command = hasWindows ? matchCommand(text) : null;
  if (command) {
    workspace.command(command);
    setCaption(text, true);
    setTimeout(() => app.state === "ready" && setCaption(""), 1500);
    setState("ready");
    return;
  }
  app.busy = true;
  app.avatar?.stop();
  addUserMessage(text);
  setCaption("");
  setState("thinking");
  const typing = addTyping();
  const fileIds = app.attachments.filter((f) => !f.pending).map((f) => f.id);
  try {
    const result = await api.chat(text, fileIds, language || lang());
    typing.remove();
    addAssistantMessage(result);
    setCaption(result.answer.replace(/\s*\[[SU]\d+\]/g, ""));
    if (result.action?.type === "open") openSource(result.action.document);
    app.busy = false;
    await speak(result.answer, result.language);
  } catch {
    typing.remove();
    toast(t("networkError"), "error");
  } finally {
    app.busy = false;
    if (app.state !== "listening") setState("ready");
  }
}

async function toggleListening() {
  if (voice.listening) {
    voice.cancel();
    setState("ready");
    setCaption("");
    return;
  }
  if (!voice.available) {
    toast(t("micUnavailable"), "error");
    return;
  }
  app.avatar?.stop();
  await app.avatar?.resume();
  setState("listening");
  setCaption("");
  try {
    const result = await voice.listen({ lang: lang(), onPartial: (text) => setCaption(text, true) });
    if (!result) {
      setState("ready");
      setCaption(t("noSpeech"), true);
      return;
    }
    setState("ready");
    await ask(result.text, { language: result.language });
  } catch (err) {
    setState("ready");
    setCaption("");
    toast(err?.name === "NotAllowedError" ? t("micDenied") : t("micUnavailable"), "error");
  }
}

// ---------- Knowledge drawer & status ----------
function renderKnowledge() {
  els.kbLabel.dataset.i18n = "";
  els.kbLabel.textContent = t("sources", app.knowledge.length);
  const intro = `<p class="kb-intro">${escapeHtml(t("welcomeBody"))}</p>`;
  if (!app.knowledge.length) {
    els.kbList.innerHTML = `${intro}<p class="kb-intro">${t("emptyKB")}</p>`;
    return;
  }
  els.kbList.innerHTML = intro + app.knowledge
    .map((d) => {
      const rows = [
        [t("owner"), d.owner], [t("approvedBy"), d.approved_by], [t("approvedOn"), d.approved_on],
        [t("version"), d.version], [t("classification"), d.classification],
      ].filter(([, v]) => v);
      return `<div class="kb-item">
        <div class="kb-item-head">${kindIcon(d.kind)}<div class="kb-item-title" dir="auto">${escapeHtml(lang() === "ar" && d.title_ar ? d.title_ar : d.title)}</div></div>
        <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd dir="auto">${escapeHtml(v)}</dd>`).join("")}</dl>
        <button type="button" class="text-btn" data-doc="${escapeHtml(d.id)}">${t("open")}</button>
      </div>`;
    })
    .join("");
  els.kbList.querySelectorAll("[data-doc]").forEach((btn) =>
    btn.addEventListener("click", () => {
      els.kbDrawer.hidden = true;
      openSource({ origin: "knowledge", id: btn.dataset.doc });
    }),
  );
}

function renderStatus() {
  const caps = app.config.capabilities;
  const row = (label, on, extra = "") =>
    `<div class="cap"><span>${label}</span><span class="${on ? "on" : ""}">${on ? t("capOn") : t("capOff")}${extra}</span></div>`;
  els.statusPopover.innerHTML = `<h3>${t("status")}</h3>
    ${row(t("capVoice"), caps.azure_speech)}
    ${row(t("capLLM"), caps.llm, caps.llm_provider ? ` · ${caps.llm_provider}` : "")}
    <div class="cap"><span>${t("capKB")}</span><span class="on">${app.config.knowledge.documents}</span></div>`;
}

// ---------- Wiring ----------
function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(140, els.input.scrollHeight)}px`;
  els.send.disabled = !els.input.value.trim();
}

function bindEvents() {
  els.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = els.input.value;
    els.input.value = "";
    autoGrow();
    ask(text);
  });
  els.input.addEventListener("input", autoGrow);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      els.composer.requestSubmit();
    }
  });
  els.mic.addEventListener("click", toggleListening);
  els.composerMic.addEventListener("click", toggleListening);
  els.stop.addEventListener("click", () => {
    app.avatar?.stop();
    setState("ready");
  });
  els.attach.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    uploadFiles([...els.fileInput.files]);
    els.fileInput.value = "";
  });
  els.clear.addEventListener("click", () => {
    els.messages.querySelectorAll(".msg").forEach((m) => m.remove());
    els.welcome.hidden = false;
    setCaption("");
  });
  els.langToggle.addEventListener("click", () => setLang(lang() === "ar" ? "en" : "ar"));
  els.voiceToggle.addEventListener("click", () => {
    app.voiceOut = !app.voiceOut;
    localStorage.setItem("zayed.voice", app.voiceOut ? "on" : "off");
    if (!app.voiceOut) app.avatar?.stop();
    paintVoiceToggle();
  });
  els.kbButton.addEventListener("click", () => {
    renderKnowledge();
    els.kbDrawer.hidden = false;
    els.kbDrawer.querySelector("[data-close]").focus();
  });
  els.kbDrawer.addEventListener("click", (e) => {
    if (e.target === els.kbDrawer || e.target.closest("[data-close]")) els.kbDrawer.hidden = true;
  });
  els.statusButton.addEventListener("click", (e) => {
    e.stopPropagation();
    renderStatus();
    els.statusPopover.hidden = !els.statusPopover.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!els.statusPopover.hidden && !els.statusPopover.contains(e.target)) els.statusPopover.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      els.kbDrawer.hidden = true;
      els.statusPopover.hidden = true;
    }
  });

  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
    dragDepth++;
    els.drop.hidden = false;
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.drop.hidden = true;
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.drop.hidden = true;
    if (e.dataTransfer?.files?.length) uploadFiles([...e.dataTransfer.files]);
  });

  workspace.onGesturesToggle = async (on) => {
    if (!on) return gestures.stop();
    try {
      await gestures.start();
    } catch {
      gestures.stop();
      workspace.toggleGestures(false);
      toast(t("gesturesFailed"), "error");
    }
  };

  onLangChange(() => {
    renderSuggestions();
    renderKnowledge();
    paintVoiceToggle();
    els.stateLabel.textContent = t(`state_${app.state}`);
  });
}

async function loadAvatar() {
  try {
    const portrait = app.config.avatar.url.endsWith(".json");
    const { Avatar, PortraitAvatar } = portrait ? await import("./portrait.js") : await import("./avatar.js");
    els.avatar.classList.toggle("portrait", portrait);
    app.avatar = new (portrait ? PortraitAvatar : Avatar)(els.avatar, app.config.avatar);
    await app.avatar.load();
    app.avatarReady = true;
    els.holo.classList.add("ready");
  } catch {
    els.fallback.hidden = false;
  }
}

async function init() {
  paintIcons();
  setLang(lang());
  renderSuggestions();
  bindEvents();
  try {
    app.config = await api.config();
    app.knowledge = (await api.knowledge()).documents;
  } catch {
    toast(t("networkError"), "error");
    setState("ready");
    return;
  }
  voice.configure({ azure: app.config.capabilities.azure_speech });
  paintVoiceToggle();
  renderKnowledge();
  const micOk = voice.available;
  els.mic.disabled = !micOk;
  els.composerMic.hidden = !micOk;
  if (!micOk) els.stageHint.dataset.i18n = "micUnavailable";
  await loadAvatar();
  setState("ready");
  if (!micOk) els.stageHint.textContent = t("micUnavailable");
  const resume = () => app.avatar?.resume();
  window.addEventListener("pointerdown", resume, { once: true });
  window.addEventListener("keydown", resume, { once: true });
}

init();
