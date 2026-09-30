# Zayed approved knowledge base

Zayed answers **only** from documents registered in `manifest.json`. A document is indexed only when its
entry has every approval field filled in and `"status": "approved"`. Files placed in this folder without a
complete manifest entry are ignored, and entries that fail validation are logged at startup.

## Adding an approved ADCMC source

1. Put the file under `approved/` (PDF, DOCX, PPTX, XLSX/CSV, Markdown or text).
2. Add an entry to `manifest.json`:

```json
{
  "id": "adcmc-leave-policy-2026",
  "title": "Leave Policy",
  "title_ar": "سياسة الإجازات",
  "file": "approved/leave-policy-2026.pdf",
  "language": "en",
  "source": "ADCMC Human Resources — official policy register",
  "owner": "Human Resources",
  "approved_by": "HR Director",
  "approved_on": "2026-01-15",
  "version": "2.1",
  "classification": "Internal",
  "status": "approved"
}
```

3. Restart the server. The startup log reports how many documents were indexed or rejected.

Required fields: `id`, `title`, `file`, `source`, `owner`, `approved_by`, `approved_on`, `status`.
To withdraw a document, set its `status` to anything other than `approved` (for example `withdrawn`) or remove the entry.

This repository ships only the Zayed user guide. **No ADCMC facts are bundled** — until approved ADCMC
documents are added, Zayed will state that it has no verified information for ADCMC questions.
