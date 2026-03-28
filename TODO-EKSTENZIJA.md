# TODO — VajbAgent Ekstenzija

## Bugovi (prioritet)

### 1. Queue poruka blokira Stop dugme
- Kad korisnik pošalje poruku u queue, send dugme postaje strelica (queue mode)
- ALI nema više način da stopira agenta — stop dugme nestaje
- **Fix:** Dodati malo X/stop dugme pored queue bar-a, ili držati stop dostupnim kao secondary action

### 2. Agent se zakuca u Plan Mode (Max model)
- Agent krene da radi, stane posle 1 tool call-a, ne nastavlja
- Korisnik mora da stopira i kaže "nastavi" — agent opet stane
- Moguć uzrok: Plan Mode šalje "Izvrši SAMO Fazu X" ali agent tumači to kao "uradi 1 stvar i stani"
- **Istraži:** Da li je problem u promptu za Plan Mode ili u loop logici

### 3. "Zaustavljeno" poruka se pojavi prerano
- Kad korisnik stopira pa nastavi, "Zaustavljeno" ostaje vidljivo u chatu
- Treba da se obriše kad agent nastavi rad

## Poboljšanja (sledeća verzija)

### 4. Queue bar — dugme za slanje odmah
- Kad je poruka u queue, dodati dugme "Pošalji sad" pored ✕
- Ovo bi stopiralo agenta i odmah poslalo keruiranu poruku
- Korisnik može: čekati (queue), otkazati (✕), ili poslati odmah (▶)

### 5. Status bar — nikad ne nestaje dok agent radi
- Delimično rešeno u v0.82.0
- Još uvek nestane na kratko između nekih faza
- Cilj: status UVEK vidljiv dok je isStreaming=true

### 6. Browser automation (Puppeteer)
- Cline ima ovo, mi nemamo
- Omogućava agenta da vidi screenshot stranice
- Nice-to-have za v2

### 7. Subagents
- Cline ima do 5 paralelnih agenata
- Korisno za široko istraživanje projekta
- Nice-to-have za v2

### 8. attempt_completion tool
- Cline ima eksplicitan "završio sam" tool koji forsira verifikaciju pre završetka
- Naš prompt ima pravila ali nema alat koji to forsira
- Razmotriti da li dodati

## Uporedba sa Cline (referenca)

- Prompt kvalitet: VajbAgent jači (anti-hallucination, evidence-based)
- Token efikasnost: VajbAgent bolji (auto-context štedi 2-3 tool call-a)
- Broj alata: Cline 24, VajbAgent 10
- Browser: Cline ima, mi nemamo
- Subagents: Cline ima, mi nemamo
- Auto-context: VajbAgent ima 6 izvora, Cline 0
