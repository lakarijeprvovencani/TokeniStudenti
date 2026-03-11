# VajbAgent — AI Coding Assistant za VS Code

AI coding assistant koji koristi native tool calling za minimalan token overhead.

## Features

- **Chat sa AI modelima** — 7 modela (GPT-5 serija + Claude)
- **Native tool calling** — ~800 tokena overhead umesto 10,500
- **6 alata** — read_file, write_file, replace_in_file, list_files, search_files, execute_command
- **Diff preview** — pregled promena pre primene
- **Vision** — paste, drag-and-drop, file picker za slike
- **Markdown** — renderovanje sa syntax highlighting
- **@file mentions** — `@src/index.js` automatski dodaje sadrzaj fajla

## Setup

1. Instaliraj extension
2. Otvori VajbAgent panel u sidebar-u
3. Unesi API key (komanda: `VajbAgent: Set API Key`)
4. Pitaj bilo sta!

## Modeli

| Model | Opis |
|---|---|
| Lite | GPT-5 Mini — svakodnevno kodiranje |
| Turbo | o4-mini — reasoning i debugging |
| Pro | GPT-5 — ozbiljniji projekti |
| Max | Claude Sonnet 4.6 — kompleksni zadaci |
| Power | GPT-5.4 — najjaci OpenAI |
| Ultra | Claude Opus 4.6 — premium |
| Architect | Claude Opus + architect prompt |
