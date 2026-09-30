import importlib

import pytest
from fastapi.testclient import TestClient

SESSION = "test-session-0001"


@pytest.fixture
def client(monkeypatch, knowledge_dir, tmp_path):
    for key in ("AZURE_SPEECH_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"):
        monkeypatch.setenv(key, "")
    monkeypatch.setenv("ZAYED_KNOWLEDGE_DIR", str(knowledge_dir))
    monkeypatch.setenv("ZAYED_UPLOAD_DIR", str(tmp_path / "uploads"))
    import zayed.config

    importlib.reload(zayed.config)
    import server

    importlib.reload(server)
    return TestClient(server.app)


def test_index_and_health(client):
    response = client.get("/")
    assert response.status_code == 200 and "Zayed" in response.text
    assert response.headers["x-content-type-options"] == "nosniff"
    assert client.get("/healthz").json()["status"] == "ok"


def test_config_exposes_no_secrets(client):
    data = client.get("/api/config").json()
    assert data["capabilities"] == {"azure_speech": False, "llm": False, "llm_provider": "none"}
    assert data["knowledge"] == {"documents": 2, "rejected": 4}
    assert "key" not in str(data).lower().replace("keys", "")


def test_speech_unavailable_without_key(client):
    assert client.get("/api/speech/token").status_code == 503
    assert client.post("/api/speech/synthesize", json={"text": "hi", "language": "en"}).status_code == 503


def test_chat_grounded_and_refusal(client):
    ok = client.post("/api/chat", json={"session_id": SESSION, "message": "How many days of annual leave?"}).json()
    assert ok["grounded"] and ok["sources"][0]["id"] == "leave"
    no = client.post("/api/chat", json={"session_id": SESSION, "message": "What is the ADCMC budget for 2027?"}).json()
    assert not no["grounded"] and no["sources"] == []


def test_chat_rejects_bad_session(client):
    response = client.post("/api/chat", json={"session_id": "../x", "message": "hi"})
    assert response.status_code == 400


def test_knowledge_endpoints(client):
    docs = client.get("/api/knowledge").json()["documents"]
    assert {d["id"] for d in docs} == {"leave", "leave-ar"}
    assert client.get("/api/knowledge/leave").json()["preview"]["html"]
    assert client.get("/api/knowledge/leave/raw").status_code == 200
    assert client.get("/api/knowledge/draft").status_code == 404


def test_upload_lifecycle(client):
    response = client.post(
        "/api/files",
        data={"session_id": SESSION},
        files={"file": ("notes.txt", b"Budget review is on Thursday.", "text/plain")},
    )
    assert response.status_code == 200
    meta = response.json()
    assert meta["kind"] == "text" and meta["has_text"]
    headers = {"X-Zayed-Session": SESSION}
    assert client.get(meta["raw_url"]).status_code == 400
    assert client.get(meta["raw_url"], headers={"X-Zayed-Session": "other-session-0002"}).status_code == 404
    assert client.get(meta["raw_url"], params={"session_id": SESSION}).content == b"Budget review is on Thursday."
    chat = client.post(
        "/api/chat", json={"session_id": SESSION, "message": "When is the budget review?", "file_ids": [meta["id"]]}
    ).json()
    assert chat["grounded"] and chat["sources"][0]["origin"] == "upload"
    assert (
        client.delete(f"/api/files/{meta['id']}", headers={"X-Zayed-Session": "other-session-0002"}).status_code == 404
    )
    assert client.delete(f"/api/files/{meta['id']}", headers=headers).status_code == 200
    assert client.get(f"/api/files/{meta['id']}", headers=headers).status_code == 404


def test_session_reset_clears_history(client):
    import server

    client.post("/api/chat", json={"session_id": SESSION, "message": "hello"})
    assert SESSION in server.assistant.history
    assert client.post("/api/session/reset", json={"session_id": SESSION}).status_code == 200
    assert SESSION not in server.assistant.history


def test_upload_rejects_unsupported(client):
    response = client.post(
        "/api/files", data={"session_id": SESSION}, files={"file": ("x.exe", b"MZ", "application/octet-stream")}
    )
    assert response.status_code == 400
