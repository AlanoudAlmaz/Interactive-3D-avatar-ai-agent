"""Language detection, Arabic/English normalisation and tokenisation."""

import re

_ARABIC_CHARS = re.compile(r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]")
_LATIN_CHARS = re.compile(r"[A-Za-z]")
_DIACRITICS = re.compile(r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]")
_TOKEN = re.compile(r"[\w\u0621-\u064A\u0660-\u0669\u0671-\u06D3]+", re.UNICODE)

_STOPWORDS = {
    # English
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "am",
    "do",
    "does",
    "did",
    "of",
    "to",
    "in",
    "on",
    "for",
    "and",
    "or",
    "with",
    "at",
    "by",
    "from",
    "as",
    "it",
    "its",
    "this",
    "that",
    "these",
    "those",
    "what",
    "which",
    "who",
    "whom",
    "how",
    "when",
    "where",
    "why",
    "can",
    "could",
    "should",
    "would",
    "will",
    "shall",
    "may",
    "might",
    "must",
    "i",
    "me",
    "my",
    "we",
    "our",
    "you",
    "your",
    "he",
    "she",
    "they",
    "them",
    "their",
    "about",
    "tell",
    "please",
    "there",
    "any",
    "some",
    "into",
    "than",
    "then",
    "so",
    "if",
    "not",
    "no",
    "yes",
    "have",
    "has",
    "had",
    "us",
    "give",
    "know",
    "explain",
    "show",
    "zayed",
    # Arabic (normalised forms)
    "في",
    "من",
    "الى",
    "على",
    "عن",
    "مع",
    "هو",
    "هي",
    "هل",
    "ما",
    "ماذا",
    "كم",
    "كيف",
    "متى",
    "اين",
    "لماذا",
    "هذا",
    "هذه",
    "ذلك",
    "تلك",
    "التي",
    "الذي",
    "الذين",
    "او",
    "ثم",
    "لا",
    "نعم",
    "كان",
    "كانت",
    "يكون",
    "ان",
    "انا",
    "نحن",
    "انت",
    "هم",
    "لي",
    "لنا",
    "لك",
    "عند",
    "كل",
    "اي",
    "قد",
    "لقد",
    "به",
    "بها",
    "له",
    "لها",
    "زايد",
    "اخبرني",
    "اشرح",
    "يرجي",
    "رجاء",
    "ممكن",
    "هناك",
    "حول",
}


def detect_language(text: str) -> str:
    """Return 'ar' when Arabic script dominates, otherwise 'en'."""
    arabic = len(_ARABIC_CHARS.findall(text or ""))
    latin = len(_LATIN_CHARS.findall(text or ""))
    return "ar" if arabic > 0 and arabic >= latin * 0.5 else "en"


def normalize(text: str) -> str:
    """Lower-case and fold Arabic orthographic variants so queries match documents."""
    text = (text or "").lower()
    text = re.sub("(?<=[\u0621-\u064a])(?:\u0627\u064b|\u064b\u0627)", "", text)
    text = _DIACRITICS.sub("", text)
    text = re.sub("[إأآٱ]", "ا", text)
    text = text.replace("ى", "ي").replace("ة", "ه").replace("ؤ", "و").replace("ئ", "ي")
    return text


def _stem(token: str) -> str:
    if _ARABIC_CHARS.search(token):
        for prefix in ("وال", "بال", "كال", "فال", "لل", "ال"):
            if token.startswith(prefix) and len(token) - len(prefix) >= 2:
                token = token[len(prefix) :]
                break
        return token
    for suffix in ("ies", "es", "s"):
        if token.endswith(suffix) and len(token) - len(suffix) >= 3:
            return token[: -len(suffix)] + ("y" if suffix == "ies" else "")
    return token


def tokenize(text: str, keep_stopwords: bool = False) -> list[str]:
    tokens = _TOKEN.findall(normalize(text))
    if not keep_stopwords:
        tokens = [t for t in tokens if t not in _STOPWORDS and len(t) > 1]
    return [_stem(t) for t in tokens]
