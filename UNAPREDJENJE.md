# VajbAgent — Plan Unapredjenja

## Trenutna ocena: 8/10
## Ciljna ocena: 9.5/10

---

## FAZA 1 — Lake pobede ✅ ZAVRSENO

### ✅ 1. Custom Instructions (.vajbagentrules)
- Korisnik kreira `.vajbagentrules` ili `.vajbagent/rules.md` u root projekta
- Agent ga ucita i injektuje u system prompt kao `<custom_instructions>`
- Limit: 8000 karaktera

### ✅ 2. Slash komande (/test, /fix, /doc, /commit, /explain, /refactor)
- Kucas `/test` i agent generise testove za trenutni fajl
- Autocomplete dropdown sa ikonama i opisima
- 6 komandi: /test, /fix, /doc, /commit, /explain, /refactor

### ✅ 3. @terminal kontekst
- Agent cita output iz VajbAgent terminala (poslednja komanda)
- Injektuje se u system prompt kao `<terminal_output>`
- Limit: 3000 karaktera

### ✅ 4. @folder mention
- @src/components — prikazuje listu fajlova (do 50 stavki) sa ikonama
- Autocomplete dropdown prikazuje i foldere (sa trailing /)
- Folderi se listaju umesto da se citaju kao fajl

### ✅ 5. Attach File / PDF dugme
- 📎 dugme za dodavanje fajlova kao kontekst
- Podrska za tekst fajlove (direktno citanje)
- Podrska za PDF (koristi `pdftotext` system komandu)

### ✅ 6. UI Overlay sistem popravljen
- ? (guide) toggle — otvara/zatvara klikom
- Svi overlay-i medjusobno ekskluzivni (ne stackuju se)
- Brisanje aktivnog chata resetuje UI na welcome ekran
- History overlay potpuno neprovidan (solid background)

---

## FAZA 2 — Srednje teske (sledeci mesec)

### 6. Cost tracking ($ po poruci)
- **Sta:** Prikaz cene svake poruke u chatu, ukupan trosak sesije
- **Kako:** Backend vec zna token usage — surface-ovati u UI
- **Tezina:** Easy-Medium (3-5 dana)
- **Rizik:** Nikakav

### 7. Multi-provider podrska (Bring Your Own Key)
- **Sta:** Korisnik moze da koristi svoj OpenAI/Anthropic/Ollama API key
- **Kako:** Settings UI za provider/key/endpoint, streaming vec govori OpenAI-compatible
- **Tezina:** Medium (1-2 nedelje)
- **Rizik:** Srednji — mora da radi sa razlicitim API formatima

### 8. Diffovi u pravom editoru (ne u sidebar-u)
- **Sta:** Kad agent edituje fajl, diff se prikazuje inline u editoru
- **Kako:** VS Code TextEditorDecorationType + accept/reject CodeLens
- **Tezina:** Medium (2-3 nedelje)
- **Rizik:** Srednji — kompleksna editor integracija

### 9. Napredne slash komande (/pr, /review, /migrate)
- **Sta:** Generisanje PR opisa, code review, migracije
- **Kako:** Napredni prompt template + vise tool poziva
- **Tezina:** Medium (1 nedelja)
- **Rizik:** Nizak

---

## FAZA 3 — Teske ali game-changing (dugorocno)

### 10. Tab Autocomplete (Ghost text)
- **Sta:** Dok korisnik kuca, AI predvidja sledecih 1-50 linija
- **Kako:** VS Code InlineCompletionItemProvider + brz model endpoint
- **Tezina:** Hard (3-6 nedelja)
- **Rizik:** Visok — potpuno nova arhitektura, zahteva brz/jeftin model
- **Napomena:** Ovo je #1 feature koji koriste svi — 50-100x dnevno

### 11. Inline Edit u editoru (Cmd+K)
- **Sta:** Selektuj kod, pritisni precicu, ukucaj instrukciju, vidi diff u editoru
- **Kako:** Custom editor overlay + streaming edit + inline diff
- **Tezina:** Hard (3-5 nedelja)
- **Rizik:** Visok — mora da bude brz i precizan

### 12. Codebase RAG / Embeddings (@codebase)
- **Sta:** Ceo projekat indeksiran u vektorsku bazu, semanticki search
- **Kako:** Embedding model + lokalni vector store (SQLite/FAISS)
- **Tezina:** Hard (4-8 nedelja)
- **Rizik:** Visok — infrastruktura, performanse, incremental indexing

### 13. Browser Testing Tool
- **Sta:** Agent otvara browser, testira UI, pravi screenshot
- **Kako:** Playwright/Puppeteer integracija ili MCP server
- **Tezina:** Hard (3-6 nedelja)
- **Rizik:** Srednji ako se radi kao MCP server

---

## Sta VajbAgent vec ima a konkurencija NEMA:

1. **Plan Mode sa phase-by-phase execution** — jedinstven UX
2. **Fallback summary** kad model vrati prazan odgovor
3. **Post-edit diagnostics** — automatska provera gresaka
4. **7 model tiers** na jednoj platformi
5. **Usage guide overlay** sa tutorijalima
6. **Web search + URL fetch** kao built-in tools
7. **Per-file checkpoint/revert** sistem
8. **VajbAgent terminal** za vidljivost komandi
9. **Custom Instructions** (.vajbagentrules)
10. **Slash komande** sa autocomplete
11. **@terminal, @folder, @file** kontekst sistem
12. **PDF attach** za citanje dokumenata
13. **Auto-Approve** inline checkbox na approval bar-u
14. **Image attach** za screenshot kontekst

---

## Prioritet implementacije:

```
✅ ZAVRSENO:
  [1] Custom Instructions    — DONE
  [2] Slash komande           — DONE
  [3] @terminal kontekst      — DONE
  [4] @folder mention          — DONE
  [5] Attach File/PDF          — DONE
  [6] UI overlay fixes         — DONE

SLEDECE (ova-sledeca nedelja):
  [7] Cost tracking            — 3-5 dana, nizak rizik
  [8] Napredne slash komande   — 1 nedelja, nizak rizik

SLEDECI MESEC:
  [9]  Multi-provider          — 1-2 nedelje
  [10] Editor diffovi          — 2-3 nedelje

DUGOROCNO:
  [11] Tab autocomplete        — 3-6 nedelja (game-changer)
  [12] Inline edit (Cmd+K)     — 3-5 nedelja
  [13] Codebase RAG            — 4-8 nedelja
  [14] Browser testing         — 3-6 nedelja
```
