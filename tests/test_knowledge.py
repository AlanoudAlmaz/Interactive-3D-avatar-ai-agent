from zayed.knowledge import KnowledgeBase


def test_only_fully_approved_documents_are_indexed(knowledge: KnowledgeBase):
    assert set(knowledge.documents) == {"leave", "leave-ar"}
    reasons = {r["id"]: r["reason"] for r in knowledge.rejected}
    assert "not 'approved'" in reasons["draft"]
    assert "approved_by" in reasons["incomplete"]
    assert reasons["missing"] == "file not found"
    assert "outside" in reasons["escape"]


def test_unapproved_content_is_not_searchable(knowledge: KnowledgeBase):
    assert not knowledge.search("cafeteria opens")
    assert not knowledge.search("secret outside")


def test_bm25_ranks_relevant_section_first(knowledge: KnowledgeBase):
    hits = knowledge.search("How many days of annual leave do employees get?")
    assert hits[0].chunk.doc_id == "leave"
    assert "30 calendar days" in hits[0].chunk.text
    assert hits[0].chunk.anchor == {"heading": hits[0].chunk.label}


def test_arabic_retrieval(knowledge: KnowledgeBase):
    hits = knowledge.search("كم يوم الاجازة السنوية؟")
    assert hits and hits[0].chunk.doc_id == "leave-ar"


def test_duplicate_ids_rejected(knowledge_dir):
    import json

    manifest = json.loads((knowledge_dir / "manifest.json").read_text(encoding="utf-8"))
    manifest["documents"].append(dict(manifest["documents"][0]))
    (knowledge_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    kb = KnowledgeBase(knowledge_dir).load()
    assert any(r["reason"] == "duplicate id" for r in kb.rejected)


def test_missing_manifest_loads_empty(tmp_path):
    kb = KnowledgeBase(tmp_path).load()
    assert kb.documents == {} and kb.search("anything") == []


def test_corrupt_approved_document_is_rejected(knowledge_dir):
    import json

    (knowledge_dir / "approved" / "broken.pdf").write_bytes(b"%PDF-1.7 truncated")
    manifest = json.loads((knowledge_dir / "manifest.json").read_text(encoding="utf-8"))
    manifest["documents"].append({**manifest["documents"][0], "id": "broken", "file": "approved/broken.pdf"})
    (knowledge_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    kb = KnowledgeBase(knowledge_dir).load()
    assert "broken" not in kb.documents and "leave" in kb.documents
    assert any(r["id"] == "broken" for r in kb.rejected)
