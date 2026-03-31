# VajbAgent — AI Coding Asistent

Tvoj licni AI partner za kodiranje, direktno u VS Code-u i Cursoru. Pise, menja, debuguje i deplojuje kod umesto tebe — na srpskom i engleskom.

## Kako poceti

1. **Napravi nalog** na [vajbagent.com/dashboard](https://vajbagent.com/dashboard) — dobijes API kljuc + besplatan kredit na poklon
2. **Instaliraj ekstenziju** — otvori VajbAgent panel u sidebar-u
3. **Unesi API kljuc** — klikni ⚙️ u toolbar-u dole, nalepi kljuc, sacuvaj
4. **Pitaj bilo sta** — agent istrazuje projekat, pise kod, i pokrece komande za tebe

## Zasto VajbAgent?

- **Bez mesecne pretplate** — platis koliko koristis, dopunis kad hoces
- **7 AI modela** — od brzog Lite do premium Architect, biras jednim klikom
- **Razume srpski** — interfejs, slash komande, podrska — sve na srpskom
- **Proaktivan** — ne govori ti sta da uradis, nego uradi sam (instalira pakete, pokrece komande, commituje)
- **Bezbedan** — svaka izmena prolazi kroz diff preview, mozes da odobris ili odbijes pre primene
- **Undo sve** — ako agent nesto pokvari, jedno dugme vraca sve fajlove na originale
- **Native tool calling** — JSON format trosi do 2x manje tokena od XML alternativa

## 3 rezima rada

- **Pitaj pre izmena** — agent pita za odobrenje pre svake izmene fajla i komande
- **Auto edit** — agent automatski menja fajlove i izvrsava komande bez pitanja
- **Plan mode** — agent pravi plan i istrazuje kod pre nego sto menja bilo sta

Biras rezim jednim klikom u toolbar-u dole desno.

## Mogucnosti

### Kodiranje
- Cita, pise i menja fajlove sa pregledom promena pre primene
- Pretrazuje kod po regex patternima i pronalazi fajlove
- Pokrece shell komande (npm install, git, build, test...) — output vidljiv u VajbAgent terminalu
- Preuzima sadrzaj sa URL-ova i pretrazuje internet za aktuelne informacije
- URL-ovi u odgovorima su klikabilni — localhost, deploy linkovi, dokumentacija

### Razumevanje projekta
- Automatski zna strukturu tvog projekta — fajlove, importove, zavisnosti
- Vidi koji fajl trenutno gledas, gde ti je kursor, i selektovani kod
- Detektuje tehnologije u projektu (React, Next.js, Express, Tailwind, Prisma...)
- Vidi otvorene tabove — zna na cemu radis
- Cita git status — branch, commitove, izmenjene fajlove

### @ Kontekst sistem
- **@fajl** — taguj fajl iz projekta sa autocomplete dropdown-om, agent ga cita kao kontekst
- **@folder/** — taguj folder, agent vidi listu fajlova unutar njega
- **@terminal** — agent cita poslednji output iz terminala (greske, logovi, build rezultati)
- **Dodaj fajl (+)** — dodaj fajl kao kontekst direktno iz file picker-a
- **Dodaj sliku (+)** — paste, drag-and-drop ili file picker — agent vidi screenshot i kodira po njemu
- **PDF podrska** — attach PDF dokument, agent izvlaci tekst i koristi kao kontekst

### Slash komande
- **/test** — generisi testove za trenutni fajl
- **/fix** — pronadji i popravi greske
- **/doc** — dodaj dokumentaciju (JSDoc/docstring)
- **/commit** — predlog commit poruke na osnovu git diff-a
- **/explain** — objasni kako kod radi
- **/refactor** — refaktorisi i poboljsaj kod

### Kvalitet koda
- Automatski proverava greske posle svake izmene i sam ih popravlja
- Vidi upozorenja i greske iz VS Code-a u realnom vremenu
- Prati stil koda u projektu — ne forsira svoj
- Validacija, error handling, bezbednost — podrazumevano, ne kao bonus

### Plan Mode
- Za vece zadatke, agent prvo napravi detaljan plan sa numerisanim fazama
- Ti odobris plan, pa ga agent izvrsava korak po korak
- Mozes da pokrenes jednu fazu ili ceo plan odjednom
- Plan se cuva u projektu za referencu

### Custom Instructions (Pravila projekta)
- Kreiraj `.vajbagentrules` fajl u root projekta (ili klikni "Uredi pravila" u Podesavanjima)
- Agent prati tvoja pravila u svakom odgovoru
- Primeri: "koristi TypeScript strict", "pnpm umesto npm", "komentari na srpskom"

### Checkpoint / Undo
- Svaka izmena se cuva — original fajl je sacuvan pre nego agent promeni bilo sta
- "Undo" dugme u chatu vraca SVE fajlove na stanje pre agentovih promena
- Mozes da vratis pojedinacne fajlove ili sve odjednom
- Nova sesija = cist pocetak, bez ostataka od prethodnog rada

### Pametni kontekst
- Pamti vazne informacije o projektu izmedju sesija (.vajbagent/CONTEXT.md)
- Automatski skracuje stare delove konverzacije da ne pukne kontekst limit
- Koristi samo onoliko konteksta koliko treba — stedi tvoje tokene

### Integracije
- **MCP podrska** — povezi Supabase, GitHub, Netlify, Vercel, file system i druge servise
- **Web Search** — agent pretrazuje internet kad mu treba aktuelna informacija
- **Unsplash** — agent pretrazuje i skida besplatne stock fotografije direktno u projekat
- **Slike** — paste, drag-and-drop ili fajl picker — agent vidi screenshot i kodira po njemu

### UX
- 7 AI modela — od brzih i jeftinih do premium nivoa, biras jednim klikom
- 3 rezima rada — Auto edit, Pitaj pre izmena, Plan mode
- Model picker — "VajbAgent · Max ▾" u toolbar-u, klikni da promenis model
- Desni klik → "Objasni kod" ili "Refaktorisi" za selektovani kod
- Copy dugme na svakom bloku koda
- Klikabilne putanje fajlova — klik otvara fajl u editoru
- Klikabilni URL-ovi — localhost, deploy linkovi, dokumentacija
- Auto-Approve — checkbox za automatsko odobrenje u toku rada
- VajbAgent terminal — komande vidljive u realnom vremenu
- Retry dugme kad dodje do greske
- Istorija sesija — sacuvaj i vrati se na prethodne razgovore
- Vodic za koriscenje — klikni ❓ u headeru
- Prevuci fajl uz **Shift** — drag-and-drop fajl u chat
- **Cmd+Shift+I** novi chat | **Escape** zaustavi generisanje

## Modeli

| Model | Najbolje za |
|---|---|
| Lite | Svakodnevno kodiranje, brzi odgovori |
| Turbo | Logika, debugging, reasoning zadaci |
| Pro | Ozbiljniji projekti, kompleksniji kod |
| Max | Plan Mode, refaktoring, arhitektura |
| Power | Flagship nivo — za kad treba najbolje |
| Ultra | Premium — najzahtevniji zadaci |
| Architect | Cele aplikacije od nule |

## Cena

Bez mesecne pretplate. Bez ugovora. Platis koliko koristis.

Besplatan kredit pri registraciji — dovoljno za probanje na Lite modelu.

Vise informacija i registracija: [vajbagent.com](https://vajbagent.com)

---

Napravljeno u Srbiji. Kreirano od strane [Nemanja Lakic](https://vajbagent.com) kao deo Vajb <kodiranje/> mentorskog programa.
