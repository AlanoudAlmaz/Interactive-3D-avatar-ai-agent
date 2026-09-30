from zayed.text import detect_language, normalize, tokenize


def test_detect_language():
    assert detect_language("What is the leave policy?") == "en"
    assert detect_language("ما هي سياسة الإجازات؟") == "ar"
    assert detect_language("ما هي سياسة ADCMC للإجازات؟") == "ar"
    assert detect_language("") == "en"


def test_normalize_folds_arabic_variants():
    assert normalize("أَحْمَد") == normalize("احمد")
    assert normalize("مدرسة") == normalize("مدرسه")
    assert normalize("مستشفى") == normalize("مستشفي")


def test_tokenize_drops_stopwords_and_strips_article():
    tokens = tokenize("What is the annual leave?")
    assert "the" not in tokens and "annual" in tokens
    assert tokenize("الإجازة") == tokenize("اجازة")
