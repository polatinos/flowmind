# CLAUDE.md — FlowMind

Projectrichtlijnen voor Claude Code in deze repository. De algemene
configuratie staat in `C:\Users\Tarik\.codex\CLAUDE.md`; dit bestand gaat
alleen over FlowMind.

## Wat is dit project?

**FlowMind** (`nl.polatinos.flowmind`) — een Homey SDK v3 app die een
AI-assistent op de Homey Pro zelf draait. Chat-UI in de app-instellingen;
de AI leest het systeem uit, stuurt apparaten aan, bouwt/bewerkt (advanced)
flows, onthoudt feiten en leest Insights-historie. Twee flow-actionkaarten
(`ai_do`, `ai_ask`) laten flows zelf de AI aanroepen.

- **Repo:** https://github.com/polatinos/flowmind (default branch `main`)
- **Doel:** publicatie in de Homey App Store

## Commands

```bash
npm ci                                  # dependencies (lockfile!)
npx homey app validate --level publish  # ALTIJD draaien vóór commit
npx homey app run                       # tijdelijk op de Homey (logs in terminal)
npx homey app install                   # permanent installeren
```

Er zijn geen unit tests; verifieer met `node --check <file>`, de validate
hierboven, en waar mogelijk een echte API-call (Zen werkt zonder key).

## Architectuur (kort)

```
app.json               Manifest: api-routes, flow-kaarten, permissions
app.js                 App-init, settings, chat-entrypoint, flow-card listeners
api.js                 Web-API handlers (/config, /chat, /memories)
settings/index.html    Chat-UI + instellingen (i18n via data-i18n + Homey.__)
locales/en.json, nl.json  Alle UI-teksten (EN = basis, NL = vertaling)
lib/
  HomeyContext.js      Homey Web API wrapper + ALLE tool-uitvoering + memory/backups
  tools.js             Provider-neutrale tooldefinities (23 tools)
  flowNormalize.js     Leesbare card-keys → UUID's voor advanced flows
  http.js              Dependency-vrije http/https JSON-client
  llm/index.js         Providerkeuze + tool-use loop + memory-injectie in prompt
  llm/{anthropic,openai,gemini}.js  Per provider; openai.js dient ook Zen/compatible
  llm/systemPrompt.js  Systemprompt met exacte flow-structuren
```

## Kritieke lessen (NIET opnieuw ontdekken)

### OpenCode Zen (default provider)
- Base URL `https://opencode.ai/zen/v1`, endpoint `/chat/completions`.
- Model-ID's zijn **kaal**: `big-pickle` — het `opencode/`-prefix uit de docs
  wordt door de API geweigerd ("Model not supported").
- Gratis modellen werken momenteel **zonder API-key** → key is `keyOptional`
  in `PROVIDERS`; niet opnieuw verplicht maken.
- Modellenlijst live checken: `GET https://opencode.ai/zen/v1/models`.

### Providers
- **Anthropic eist strikt alternerende user/assistant-rollen.** anthropic.js
  voegt opeenvolgende gelijke rollen samen — weghalen breekt de chat na één
  mislukte beurt.
- `http.js` ondersteunt bewust ook `http://` (Ollama op LAN). Niet
  "opschonen" naar https-only.
- `homey-api` staat via de lockfile op **3.17.3**; 3.19+ eist Node ≥ 24 en de
  Homey-runtime is ouder. Niet blind updaten.

### Homey App Store
- **"Homey" mag niet in de appnaam** (Athom-richtlijn). Vandaar FlowMind.
- **Het app-ID kan na publicatie nooit meer wijzigen.**
- `homey:manager:api` permissie ⇒ langere review (bekend, geaccepteerd).
- Versie bumpen in **app.json én package.json** (moeten gelijk lopen).

### Flow-kaarten
- Actionkaarten mét `tokens` (zoals `ai_ask`) zijn **alleen zichtbaar in
  Advanced Flows** — daarom bestaat `ai_do` (zonder token) apart.
- Flow-runlisteners hebben een krap tijdsbudget: flow-runs gaan door
  `_runFromFlow()` met `maxSteps: 6` en een `[flow]`-prefix zodat de
  systemprompt bevestigingsvragen overslaat.

### Geheugen & opslag (Homey Pro = beperkt)
- Limieten staan als constanten bovenin `HomeyContext.js`:
  `MEMORY_MAX_COUNT` 50 × max 500 tekens; prompt-injectie gebudgetteerd op
  `MEMORY_PROMPT_BUDGET` 4000 tekens (nieuwste eerst, rest via
  `list_memories`). Vol ⇒ `save_memory` geeft een error en het model moet
  eerst consolideren.
- Flow-backups: max 15 stuks én max ~300 KB totaal (`BACKUP_MAX_*`).
- Nieuwe opslag in settings? Altijd een count- én size-cap toevoegen.

### i18n
- Engels is de basistaal; alle UI-strings in `locales/en.json` + `nl.json`
  (keys moeten 1-op-1 gelijk zijn). Statische HTML via `data-i18n`,
  dynamische strings en placeholders via `Homey.__('settings.…')`.
- Geen hardcoded UI-teksten in settings/index.html zetten.

### Advanced flows
- Card-graph: keys mogen leesbaar zijn (`trigger1`); `flowNormalize.js`
  hermapt ze (incl. `input`-referenties `key::output`) naar UUID's.
- Device-card-ID's volgen `homey:device:<deviceId>:<cardId>` — altijd via
  `get_flow`/`list_flow_cards` opzoeken, nooit gokken (staat ook in de
  systemprompt).

## Eerste test op echte Homey (v0.2.0 — nog NIET gedaan)

Alles hieronder is alleen offline/e2e-tegen-Zen geverifieerd; dit moet nog op
een echte Homey Pro (zelfde wifi-netwerk vereist, `homey login` eenmalig):

```bash
npm ci && npx homey app run   # laat draaien; logs verschijnen in de terminal
```

Checklist, in volgorde (instellingenpagina: Homey-app → FlowMind → Instellingen):

1. **Chat zonder key** — direct een vraag typen ("hoeveel apparaten heb ik?").
   Verwacht: antwoord via Zen/big-pickle, acties zichtbaar onder het antwoord.
2. **Device aansturen** — "zet lamp X aan/uit". Check dat het echt gebeurt.
3. **Geheugen** — "onthoud dat …" → verschijnt in de Geheugen-sectie (count
   gaat omhoog); "vergeet dat" → weer weg. Nieuw gesprek starten en checken
   dat de AI het feit nog kent.
4. **Standaard flow maken** — simpele opdracht; check in de Homey-app.
5. **Advanced flow maken** — check dat de kaarten goed verbonden zijn.
   Risico: verkeerde card-id's; de AI hoort eerst een bestaande flow te
   inspecteren.
6. **Flow-kaarten** — Advanced Flow met "Vraag FlowMind…"-kaart; check dat
   het antwoord-token in een volgende kaart bruikbaar is. Risico: flow-
   timeout bij trage modellen (maxSteps staat op 6 voor flow-runs).
7. **Insights** — "hoe warm was het vannacht in <zone>?".
8. **Moods** (indien aanwezig) — "activeer mood X" (`moods.setMood` is nog
   nooit live getest).
9. **NL/EN** — controleer dat de settings-pagina in het Nederlands verschijnt
   (Homey staat op NL).

Bevindingen/fixes: versie bumpen (app.json + package.json), valideren,
committen; pushen alleen na toestemming.

## Werkwijze

- Elke wijziging: `npx homey app validate --level publish` moet slagen.
- Nieuwe tool? Drie plekken: `tools.js` (definitie), `HomeyContext.js`
  (implementatie + `executeTool`-case), evt. systemprompt-uitleg.
- Commits in het Engels; lokaal committen mag, **pushen alleen na
  toestemming van Tarik** (zie algemene CLAUDE.md).
