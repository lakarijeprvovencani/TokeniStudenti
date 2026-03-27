# Zaštita od zloupotrebe — VajbAgent

## Trenutno stanje (mart 2026)

### ✅ Šta imamo

| Zaštita | Detalji |
|---------|---------|
| IP rate limit na registraciju | Max 2 naloga po IP, persistentno u JSON + Redis |
| HMAC token za registraciju | Potpisan, ističe za 30min, min 2s delay (anti-bot) |
| Honeypot polje | Skriveno polje — botovi ga popune i budu blokirani |
| Duplikat email check | Case-insensitive, sprečava isti email dva puta |
| IP logging | Loguje IP + X-Forwarded-For za svaku registraciju |
| IP whitelist | Samo localhost prolazi bez limita |
| Rate limit na API | 120 req/15min po ključu |
| Rate limit na recovery | 3 zahteva/sat |
| Helmet + CORS | Security headers |

### ❌ Šta fali

#### 1. Email verifikacija — KRITIČNO
- Korisnik može da unese lažni email i dobije $2
- Nema potvrde — nalog odmah aktivan
- **Fix:** Poslati verifikacioni link, aktivirati nalog tek kad klikne

#### 2. CAPTCHA — KRITIČNO
- Honeypot ne štiti od pametnih skripti
- **Fix:** Dodati Cloudflare Turnstile (besplatan) ili reCAPTCHA v3

#### 3. Device fingerprinting — SREDNJE
- Ne pratimo browser/device fingerprint
- Ista osoba sa VPN-a = novi korisnik
- **Fix:** FingerprintJS ili slično, čuvati hash uz registraciju

#### 4. New account throttling — SREDNJE
- Novi nalog može odmah da troši svih $2 bez ograničenja
- **Fix:** Max 5 API poziva u prvih sat vremena za nove naloge

#### 5. IP limit previsok
- Sa VPN rotacijom, 50 IP adresa = 100 naloga = $200 besplatno
- **Fix:** Smanjiti MAX_REGISTRATIONS_PER_IP na 1

## Prioriteti za implementaciju

1. **Cloudflare Turnstile** — ~30min posla, blokira 90% botova
2. **Smanjiti IP limit na 1** — promena u .env
3. **Email verifikacija** — slati link, aktivacija tek nakon klika
4. **Smanjiti bonus** na $1 dok nema verifikacije
5. **New account rate limit** — throttle za sveže naloge
6. **Device fingerprinting** — dugoročno

## Konfiguracione varijable (.env)

```
MAX_REGISTRATIONS_PER_IP=2    # trenutno 2, preporučeno 1
SELF_REGISTER_BONUS=2         # trenutno $2, preporučeno $1 bez verifikacije
MAX_STUDENTS=10000            # max ukupno naloga
```
