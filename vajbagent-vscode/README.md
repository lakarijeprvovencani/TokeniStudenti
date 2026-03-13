# VajbAgent — AI Coding Asistent

Tvoj licni AI partner za kodiranje, direktno u VS Code-u. Pise, menja, debuguje i deplojuje kod umesto tebe — na srpskom i engleskom.

## Kako poceti

1. **Napravi nalog** na [vajbagent.com/dashboard](https://vajbagent.com/dashboard) — dobijes API kljuc + $2 kredita na poklon
2. **Instaliraj ekstenziju** — otvori VajbAgent panel u sidebar-u
3. **Unesi API kljuc** — klikni ⚙️ gore desno, nalepi kljuc, sacuvaj
4. **Pitaj bilo sta** — agent istrazuje projekat, pise kod, i pokrece komande za tebe

## Zasto VajbAgent?

- **Bez mesecne pretplate** — platis koliko koristis, dopunis kad hoces
- **Razume srpski** — pitaj na svom jeziku, agent odgovara na istom
- **Proaktivan** — ne govori ti sta da uradis, nego uradi sam (instalira pakete, pokrece komande, commituje)
- **Bezbedan** — svaka izmena prolazi kroz diff preview, mozes da odobris ili odbijes pre primene
- **Undo sve** — ako agent nesto pokvari, jedno dugme vraca sve fajlove na originale

## Mogucnosti

### Kodiranje
- Cita, pise i menja fajlove sa pregledom promena pre primene
- Pretrazuje kod po regex patternima i pronalazi fajlove
- Pokrece shell komande (npm install, git, build, test...)
- Preuzima sadrzaj sa URL-ova i pretrazuje internet za aktuelne informacije

### Razumevanje projekta
- Automatski zna strukturu tvog projekta — fajlove, importove, zavisnosti
- Vidi koji fajl trenutno gledas, gde ti je kursor, i kod na ekranu
- Detektuje tehnologije u projektu (React, Next.js, Express, Tailwind, Prisma...)
- Vidi otvorene tabove — zna na cemu radis
- Cita git status — branch, commitove, izmenjene fajlove

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

### Checkpoint / Undo
- Svaka izmena se cuva — original fajl je sacuvan pre nego agent promeni bilo sta
- "Undo" dugme u chatu vraca SVE fajlove na stanje pre agentovih promena
- Nova sesija = cist pocetalo, bez ostataka od prethodnog rada

### Pametni kontekst
- Pamti vazne informacije o projektu izmedju sesija (.vajbagent/CONTEXT.md)
- Automatski skracuje stare delove konverzacije da ne pukne kontekst limit
- Koristi samo onoliko konteksta koliko treba — stedi tvoje tokene

### Integracije
- **MCP podrska** — povezi Supabase, GitHub, Netlify, Vercel, i druge servise
- **Web Search** — agent pretrazuje internet kad mu treba aktuelna informacija
- **Slike** — paste, drag-and-drop ili fajl picker — agent vidi screenshot i kodira po njemu

### UX
- 7 AI modela — od brzih i jeftinih do premium nivoa
- Desni klik → "Objasni kod" ili "Refaktorisi" za selektovani kod
- Copy dugme na svakom bloku koda
- Klikabilne putanje fajlova — klik otvara fajl u editoru
- Predlozi posle svakog odgovora (Nastavi, Popravi, Objasni...)
- Retry dugme kad dodje do greske
- Istorija sesija — sacuvaj i vrati se na prethodne razgovore
- **Cmd+L** novi chat | **Escape** zaustavi generisanje

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

$2 na poklon pri registraciji — dovoljno za ~100+ poruka sa Lite modelom.

Vise informacija i registracija: [vajbagent.com](https://vajbagent.com)

---

Napravljeno u Srbiji. Kreirano od strane [Nemanja Lakic](https://vajbagent.com) kao deo Vajb <kodiranje/> mentorskog programa.
