function sessionId() {
  let id = sessionStorage.getItem("zayed.session");
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    sessionStorage.setItem("zayed.session", id);
  }
  return id;
}

export const SESSION_ID = sessionId();

async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = response.statusText;
    try {
      detail = (await response.json()).detail || detail;
    } catch {
      /* non-JSON error body */
    }
    const error = new Error(typeof detail === "string" ? detail : response.statusText);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  config: () => request("/api/config"),
  knowledge: () => request("/api/knowledge"),
  knowledgeDoc: (id) => request(`/api/knowledge/${encodeURIComponent(id)}`),
  file: (id) => request(`/api/files/${encodeURIComponent(id)}`),
  deleteFile: (id) => request(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE" }),
  chat: (message, fileIds, language) =>
    request("/api/chat", json({ session_id: SESSION_ID, message, file_ids: fileIds, language })),
  synthesize: (text, language) => request("/api/speech/synthesize", json({ text, language })),
  speechToken: () => request("/api/speech/token"),
  upload(file) {
    const form = new FormData();
    form.append("file", file);
    form.append("session_id", SESSION_ID);
    return request("/api/files", { method: "POST", body: form });
  },
};
