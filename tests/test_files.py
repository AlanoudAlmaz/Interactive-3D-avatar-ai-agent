import pytest
from conftest import make_docx

from zayed.files import FileStore


def test_save_search_reload_delete(store: FileStore, tmp_path):
    stored = store.save(
        "session-abc", "../../report.docx", make_docx([("h1", "Summary"), ("p", "Response time 3.5 hours.")])
    )
    assert stored.filename == "report.docx"
    assert stored.public()["raw_url"] == f"/api/files/{stored.id}/raw"
    assert store.search("response time", [stored.id])[0].chunk.doc_id == stored.id
    assert store.search("response time", []) == []

    reloaded = FileStore(store.root, store.max_bytes).load()
    assert reloaded.get(stored.id) is not None

    assert store.delete(stored.id)
    assert store.get(stored.id) is None
    assert not (store.root / stored.id).exists()


def test_rejects_empty_oversized_and_unsupported(store: FileStore):
    with pytest.raises(ValueError):
        store.save("session-abc", "a.txt", b"")
    with pytest.raises(ValueError):
        store.save("session-abc", "a.txt", b"x" * (store.max_bytes + 1))
    with pytest.raises(ValueError):
        store.save("session-abc", "a.exe", b"MZ")


def test_get_rejects_malformed_ids(store: FileStore):
    assert store.get("../etc/passwd") is None
    assert store.get("") is None
