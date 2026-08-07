# SESSIONS.md — FlowMind

Chronologisch werklogboek: wat er per sessie gebeurde, in volgorde.

**Rolverdeling met de andere docs** — dit bestand vertelt *wanneer* en *in
welke volgorde*. `CLAUDE.md` bevat de blijvende lessen en projectregels
(waarom iets zo is), `README.md` legt aan gebruikers uit wat de app doet.
Zet een les dus in CLAUDE.md, niet hier; hier komt alleen het verloop.

Sessies zijn afgeleid uit de git-historie (tijden = commit-tijden, lokale
tijd). Nieuwste onderaan.

---

## Sessie 1 — 2026-07-20, 18:02–18:27

Opzet van het project.

- GitHub Actions-integratie, daarna de eerste app: een Homey SDK v3-app met
  een AI-assistent en chat in de app-instellingen.
- `package-lock.json` erbij voor reproduceerbare installs.

Commits: `fbf9ad0` → `4d2eacb`

---

## Sessie 2 — 2026-07-21, 07:27–07:44

Van assistent naar iets bruikbaars.

- Flows bewerken, back-ups, extra LLM-providers, en (toen nog) code-uitvoering.
- **OpenCode Zen** met het gratis Big Pickle-model als standaardprovider, zodat
  de app zonder API-sleutel werkt.
- In-chat schakelaar om per bericht tussen gratis en betaald te wisselen.

Commits: `1de0dfc` → `2e9f551`

---

## Sessie 3 — 2026-07-21, 16:36–17:55

Naam, taal en de eerste harde grenzen van de Homey Pro.

- **Hernoemd naar FlowMind**: "Homey" mag niet in een appnaam volgens Athom.
- Fixes: `http://` voor lokale providers (Ollama), Anthropic's eis van strikt
  alternerende rollen, model-lijsten ververst, Zen-model-ID gecorrigeerd
  (kaal, zonder `opencode/`-prefix) en de Zen-sleutel optioneel gemaakt.
- v0.2.0: Engelse basistaal + i18n, flow-kaarten (`ai_do`/`ai_ask`), blijvend
  geheugen, Insights-tools.
- Geheugen en back-ups begrensd (Homey Pro heeft weinig opslag); project
  `CLAUDE.md` aangemaakt.

Commits: `a50d8ad` → `c71569e`

---

## Sessie 4 — 2026-07-21, 21:02–23:40 — eerste echte test op de Homey

De avond waarop de app voor het eerst op Tarik's Homey Pro draaide. Elke
uitkomst is tegen de Homey-API zelf gecontroleerd, niet tegen wat de
assistent beweerde.

- v0.2.1: chatbeurten als **achtergrondjobs**, omdat de instellingenpagina
  requests na ~10s afkapt terwijl een AI-beurt 15-60s duurt.
- v0.2.2: Markdown renderen in antwoorden.
- v0.2.3: waarden omzetten naar het type dat Homey verwacht (modellen stuurden
  `"false"` als tekst).
- **Blokkade gevonden:** flows aanmaken faalt met "Missing Scopes" — het
  app-token mag dat niet, een bewuste beperking van Athom.
- v0.3.0: **optionele Homey API-sleutel** lost dat op; live geverifieerd
  (connect → createFlow → delete). Test 4 en 5 geslaagd.
- v0.3.1: tool `search_flow_card_autocomplete`, na de les dat het model zonder
  autocomplete de verkeerde kaart koos (tijdlijn in plaats van telefoon-push).
  Daarna kwam de pushmelding wél aan.

Commits: `a3f19c6` → `3a7c500`

---

## Sessie 5 — 2026-07-22, 00:34–01:18 — nachtsessie

UI, de desktop-oplossing, en twee incidenten die het model zelf veroorzaakte.

- v0.4.0: terminal-UI, live actielog via realtime `chatStep`-events,
  slash-commando's, persoonlijkheid in de systemprompt.
- v0.5.0–0.5.2: **eigen webterminal op LAN-poort 8737**, omdat Homey's
  settings-modal op desktop een vaste ~330px iframe is. Token-beveiligd,
  grotere letters, en openen met één klik via `Homey.openURL`.
- v0.5.3: vertraagde acties via een tijdelijke flow met delay.
- v0.5.4: **het model verzon een device-UUID** in flow-kaarten; Homey slaat
  zo'n flow gewoon op en doet stil niets, waarna het model "Gedaan" meldde.
  `_assertDeviceCardsExist` weigert nu onbekende device-ids.
- Test daarna correct — maar de fysieke **Govee-lamp ging nooit uit** terwijl
  Tarik ernaast zat. Les: capability-status en Insights bewijzen géén fysieke
  verandering bij optimistische cloud-drivers.

Commits: `fde32e2` → `7985434`

---

## Sessie 6 — 2026-07-22, ochtend/middag — security-review

Tarik was niet thuis; de Homey bleek offline en later instabiel.

- **Homey offline**, bevestigd via twee bronnen (connector + my.homey.app),
  terwijl Athom's statuspagina alles operationeel meldde. Later kwam hij
  één request lang op (39 flows) en viel toen weer weg met een 10s-timeout.
  **Flappert dus** — oorzaak lokaal, nog niet vastgesteld.
- Geplande flow-test **afgeblazen**: op een wegvallende Homey is geen
  betrouwbaar testresultaat te halen.
- **Security-review uitgevoerd** (Tarik's agendapunt vóór indiening bij
  Athom). Zwaarste bevindingen lokaal met Node bewézen, niet beredeneerd:
  Node's `vm` is geen sandbox (escape naar `process` en een shell-commando),
  en de 10s-scripttimeout onderbrak synchrone code niet.
- v0.5.5: **`run_script` volledig verwijderd** — tool, toggle, setting,
  promptsecties, teksten. Keuze van Tarik: eruit in plaats van hardenen.
- Review vastgelegd in `CLAUDE.md`; vier punten staan nog open
  (webterminal-hardening, rate limiting, provider-override, `.homeyignore`).

Commits: `5d8e93a`

**Openstaand bij afsluiten:** 5 commits lokaal vóór op `origin/main` (nog niet
gepusht); tests 6/7/8 en de flow-test wachten tot de Homey stabiel is.

---

## Sessie 7 — 2026-08-07 — oorzaak van het wegvallen + `check_flows`

Tarik zat in Turkije; de Homey viel opnieuw weg en werd door iemand thuis
herstart. Begon als storingsonderzoek, eindigde in een nieuwe tool.

- **Oorzaak van het flapperen gevonden: geheugendruk, geen wifi.** Twee metingen
  kort na een verse herstart: 1,64 van 1,99 GB bezet bij uptime 2 minuten, en
  swap groeide binnen vijf minuten van 6 naar 57 MB. Niet één lekkende app maar
  het aantal — 41 apps à ~17-20 MB vaste Node-overhead per app.
- Eerste LAN-scan was **waardeloos**: die scande het vakantieadres, niet Tariks
  huis. Beide netwerken draaien toevallig op 192.168.68.0/24 (TP-Link Deco-
  standaard). Alleen de cloudstatus was locatie-onafhankelijk bruikbaar.
- **Alle 39 flows doorgelezen** om te bepalen welke apps echt in gebruik zijn.
  Dat redde Loops, CountDown, LG ThinQ en Cast a text to Google van de weglijst:
  die zitten in actieve flows, ondanks dat ze op het eerste gezicht ongebruikt
  leken. CallMeBot bleek juist alleen via `logic:http` te lopen, niet via de app.
- Tarik verwijderde Home Assistant, HomeyScript, Zendo, Video, LG TV (IR) en
  Dyson. Resultaat: vrij geheugen 404 → 540 MB, swap 57 → 30 MB.
- Op de Homey stond al een zelfgebouwde workaround-flow **"Systeem Herstel"**
  die 16 apps herstart — maar met een `day_number = 1`-conditie, dus één keer
  per maand. Aanpassen naar dagelijks is uitgesteld tot Tarik thuis is: enkele
  apps eisen na een herstart opnieuw inloggen, en camera's/slot/alarm hangen
  eraan.

**Nieuw: `check_flows` (v0.6.0).** Uit dat onderzoek kwam een concreet gat.
Homey markeert een flow alleen als `broken` wanneer een kaart zelf verdwijnt;
een `restart_app`-kaart waarvan het *argument* naar een verwijderde app wijst
blijft "gezond" heten. Precies dat staat in Systeem Herstel voor de verwijderde
Dyson-app, op plek 2 van een ketting van 16 — Homey meldt `broken: false`
terwijl 14 kaarten erachter nooit meer draaien. De community-app Flow Checker
leunt op diezelfde vlag en mist het dus ook.

- Ontwerp eerst vastgelegd in `docs/superpowers/specs/2026-08-07-flow-diagnose-design.md`.
- Read-only tool; repareren blijft bij de bestaande `update_*`-tools mét backup.
- Aansturing via de chat én via de bestaande `ai_ask`-kaart, zodat Homey's eigen
  cron het plannen doet en de app geen timer of state nodig heeft.
- Grafenlogica los getest met een scratch-script (12 checks, alle groen),
  waaronder de gevallen waar naïef stroomafwaarts tellen fout gaat: kaarten met
  een tweede inkomende route, een gevuld `outputError` als bewust vangnet, en
  lussen.
- Testcase blijft bewust staan: de Dyson-kaart wordt pas opgeruimd nadat de tool
  hem op de echte Homey heeft gevonden.

**Review door Fable 5.** Vijf punten waren raak en zijn verwerkt: `start`-kaarten
werden niet als wortel herkend (waardoor handmatig startbare flows altijd "0
geblokkeerd" meldden), een onbekend `flowId` gaf "geen problemen gevonden",
uitgeschakelde en gecrashte apps werden gemist, het API-sleutel-advies verscheen
ook bij een timeout, en standaardflow-kaarten dragen hun app-id in `id` in plaats
van `ownerUri`. Eén punt is na controle verworpen: de aanname dat `any`/`all`-
joins hun verbindingen in een `input`-array hebben komt uit `flowNormalize.js`,
het schrijf-formaat — in de 24 opgehaalde advanced flows had geen enkele
`any`-node zo'n array. Tests uitgebreid van 12 naar 22 checks.

Commits: `0096fb8` (spec), `fe84e71` (v0.6.0) — gepusht naar `origin/main`.

**Openstaand bij afsluiten:** installeren en testen op de Homey wacht tot Tarik
thuis is; de Dyson-kaart in Systeem Herstel blijft bewust staan als testcase;
Systeem Herstel naar dagelijks; IcalCalendar (71 MB, groeiend, enige flow staat
uit) is nog een keuze; CallMeBot vervangen door een ElevenLabs-belwebhook is een
apart traject, veiligheidskritisch vanwege de SOS-flow.
