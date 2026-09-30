from zayed.assistant import REFUSAL, Assistant


def test_refuses_unknown_adcmc_facts(assistant: Assistant):
    answer = assistant.answer("session-abc", "Who is the director general of ADCMC?", [])
    assert not answer.grounded
    assert answer.text == REFUSAL["en"]
    assert answer.sources == []


def test_refuses_in_arabic(assistant: Assistant):
    answer = assistant.answer("session-abc", "من هو مدير عام ADCMC؟", [])
    assert not answer.grounded and answer.language == "ar"
    assert answer.text == REFUSAL["ar"]


def test_answers_from_approved_source_with_citation(assistant: Assistant):
    answer = assistant.answer("session-abc", "How many days of annual leave do employees get?", [])
    assert answer.grounded
    assert "30 calendar days" in answer.text and "[S1]" in answer.text
    source = answer.sources[0]
    assert source["id"] == "leave" and source["approved_by"] == "HR Director"


def test_arabic_answer_uses_arabic_title(assistant: Assistant):
    answer = assistant.answer("session-abc", "كم يوم الاجازة السنوية؟", [])
    assert answer.grounded and answer.language == "ar"
    assert "سياسة الإجازات" in answer.text


def test_open_request_returns_action(assistant: Assistant):
    answer = assistant.answer("session-abc", "Open the annual leave policy", [])
    assert answer.action == {"type": "open", "document": answer.sources[0]}


def test_upload_answers_are_marked_as_upload(assistant: Assistant):
    stored = assistant.files.save("session-abc", "notes.txt", b"The project deadline is 14 November.")
    answer = assistant.answer("session-abc", "What is the project deadline?", [stored.id])
    assert answer.grounded
    assert answer.sources[0]["origin"] == "upload" and "[U1]" in answer.text


def test_uploads_are_scoped_to_their_session(assistant: Assistant):
    stored = assistant.files.save("session-abc", "notes.txt", b"The project deadline is 14 November.")
    answer = assistant.answer("session-other", "What is the project deadline?", [stored.id])
    assert not answer.grounded


def test_greeting_is_conversational(assistant: Assistant):
    answer = assistant.answer("session-abc", "hello", [])
    assert answer.mode == "conversational" and "Zayed" in answer.text


def test_detected_voice_language_is_preserved(assistant: Assistant):
    assert assistant.answer("session-abc", "ADCMC", [], "ar", language_detected=True).language == "ar"
    assert assistant.answer("session-abc", "ADCMC", [], "ar").language == "en"


def test_forget_clears_history(assistant: Assistant):
    assistant.answer("session-abc", "hello", [])
    assistant.forget("session-abc")
    assert "session-abc" not in assistant.history
