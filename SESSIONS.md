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

---

## Sessie 8 — 2026-08-09 — korte sessie: opschoning vastgelegd

De splitsing van sessie 7 (chronologie uit `CLAUDE.md` naar de bijlage
hieronder) stond nog los in de werkmap. Gecontroleerd, gecommit als `8d5cc2e`
"Split the guide from the log" en gepusht naar `origin/main`.

Verder niets aan de app gewijzigd: Tarik was niet thuis en wilde niets aan de
Homey doen wat hij niet kon controleren. De openstaande punten van sessie 7
staan dus onveranderd: tests 6/7/8 en `check_flows` live, plus de vier
security-punten in de bijlage.

---

## Sessie 9 — 2026-10-01 — tweede Homey op kantoor, v0.6.1

**Kantoor-Homey als testomgeving.** Naast de Homey Pro thuis heeft Tarik een
**Homey Self-Hosted Server** op kantoor (oude Toshiba-laptop, Ubuntu 24.04,
`home-kantoor`). Lokale API op poort **4859** in plaats van 80. Er staan 10
apparaten en 2 advanced flows op, en er draait niets veiligheidskritisch, dus
het is een rustiger testbed dan thuis (geen SOS-flow, geen geheugendruk).
De Homey-koppeling in Claude (MCP) ziet alleen de Pro; Claude werkt op kantoor
via een eigen API-sleutel ("Claude", buiten de repo opgeslagen).

- FlowMind v0.6.0 geïnstalleerd met `homey app install` (CLI via
  `homey select` op de SHS gezet). Draait, ~75 MB.
- Eigen sleutel "flowmind kantoor" in FlowMind gezet → `homeyApi.mode: 'local'`.
  `getLocalAddress()` levert op SHS dus het adres mét poort; de bestaande
  adreslogica werkt zonder aanpassing.

**Incident → v0.6.1.** De Homey-sleutel belandde eerst in het **Zen**-veld.
Bij de volgende chat was hij naar opencode.ai gegaan. Tarik kon hem niet zelf
wissen: `saveConfig` negeert lege sleutelvelden en alleen de Homey-sleutel had
een verwijderknop. Claude heeft hem met Tariks akkoord via `unsetAppSetting`
weggehaald (er was nog niet gechat).

- Elke AI-sleutel heeft nu een eigen "Verwijder sleutel"-knop
  (`clearProviderKey`), alleen zichtbaar als die sleutel gezet is.
- Een waarde met de vorm van een Homey-sleutel (`uuid:uuid:hex`) wordt in elk
  AI-veld geweigerd: client-side direct, en server-side vóór er iets wordt
  weggeschreven.
- Live getest op kantoor met nepwaarden: de nep-Homey-sleutel werd geweigerd
  (HTTP 500 met melding, ook `model` niet opgeslagen), en een dummy Zen-sleutel
  kon gezet en weer gewist worden.

**Gezien in de kantoor-flows** (niet aangepast): "Waarschuwingen Webhooks"
vuurt bij de brievenbus-trilsensor op zowel tilt als trilling, wat waarschijnlijk
een dubbele kritieke push per opening geeft, zonder cooldown. Die flow hangt ook
aan de webhooks `cbr-saldo-negatief` en `crm-storing`.

**Zen dicht → v0.6.2.** De eerste chat op kantoor faalde met `403
FreeTierError`. Rechtstreeks nagespeeld: OpenCode laat de gratis Zen-modellen
alleen nog toe vanuit hun eigen client (zie CLAUDE.md). Tarik kiest Anthropic.

- `anthropic.js`: default `claude-opus-5-5` (lijst: Opus 5.5, Sonnet 5.5,
  Haiku 4.5). `max_tokens` van 4096 naar 16000, omdat de nieuwe modellen altijd
  denken en dat telt mee. `fallbacks: "default"` voor de modellen die dat
  kennen, nette melding bij `stop_reason: "refusal"`, en top-level
  `cache_control` (systeemprompt + tools zijn gelijk in de hele tool-loop).
  De loop is append-only, en eerdere beurten gaan zonder thinking-blocks mee,
  dus de preserved-thinking-check van nieuwe accounts gaat niet af.
- Chat-UI: een fout staat nu één keer in beeld (rood, in het gesprek) in plaats
  van twee keer.
- Webterminal aangezet op kantoor: `192.168.68.106:8737` is bereikbaar op het
  LAN (403 zonder token). Hij werkt dus ook vanuit de SHS-container.
- Live getest met Tariks eigen Anthropic-sleutel: een vraag die alleen uitleest
  kwam in 8 s terug, en het antwoord klopte met de Homey zelf. Daarna bouwde
  FlowMind op kantoor een echte flow (kubus schudden → push). Gecontroleerd tegen
  de API: de kaarten bestaan echt, de melding kwam binnen, en verwijderen ging
  mét een automatische back-up. v0.6.1 en v0.6.2 staan op `origin/main`.

**Is FlowMind slim genoeg voor flow-reviews?** Zonder hint gevraagd om de
kantoor-flows te beoordelen. In 55 s vond hij de dubbele brievenbusmelding, en
ook punten die Claude Code had gemist (vertraging die doorloopt na "uit", een
SwitchBot-kaart als enkel faalpunt, kritieke meldingen 's nachts). Alles klopte
na controle, en hij heeft niets gewijzigd. Risico bij grote huizen: flows worden
één voor één en als ruwe data (ID's zonder namen) gelezen, met maximaal 10
stappen per vraag. Of hij thuis ook goed is, moet de test daar uitwijzen.

**Referentielijst thuis.** Claude Code heeft alle 42 flows thuis via de cloud
gelezen (alleen lezen) en 18 bevindingen vastgelegd in
`private/referentielijst-thuis-2026-10-01.md`. Die map staat in `.gitignore`,
want hij bevat details over het huis. De lijst is de maatstaf voor de
FlowMind-test thuis. Belangrijkste punten: de drie alarmflows staan uit, terwijl
de pauze- en hervatflows nog "alarm ingeschakeld" melden. Bij de SOS-flow hangt
de waarschuwing thuis achter één CallMeBot-call, en het is onduidelijk wie de
webhook nog stuurt. Tarik heeft namelijk geen Home Assistant meer; alleen Ali
heeft er een. Verder zitten 7 verwijderde apparaten nog in 9 flows.

**Overig.** De LG-tv en de LG ThinQ-app zijn van de kantoor-Homey gehaald (werkten
niet). Een officiële Homey-app die een YouTube-link op een LG-tv opent, bestaat
niet. Een "Webhooks"-overzichtsflow (alleen notities) is besproken, maar bewust
nog niet aangemaakt.

**Kantoor uitgebreid (einde middag).** Een Aqara-deursensor P2 (Thread) werkt via
Matter, met de Aqara Hub M3 als Thread Border Router: de koppelcode uit de
Aqara-app ingevoerd in Homey. De sirene en het alarm van de M3 worden via Matter
niet doorgegeven. Verder kwam er een SwitchBot Bot via Bluetooth bij. Claude
installeerde de Eufy Security-app met `api.apps.installFromAppStore`; de HomeBase
en 3 camera's staan erin. Het kantooralarm wordt de eerste grote advanced-flow
test voor FlowMind, met Google-speakers in het hoofdkantoor, omdat de HomeBase
daar niet staat.

**Gezien thuis:** alle 6 Eufy-apparaten zijn onbereikbaar voor Homey ("Device
Serial niet gevonden"). Waarschijnlijk is de inlog van de Eufy-app verlopen.
Tarik logt thuis opnieuw in. Dat `check_flows` niet naar de beschikbaarheid van
apparaten kijkt, is een gat in FlowMind.

**2026-10-03, thuis (alleen kijken, het gezin sliep of zat beneden).** FlowMind
thuis draait nog op v0.5.4. Installeren van v0.6.2 lukte niet: de pc ziet de
Homey niet op het LAN (vermoedelijk Deco-apparaatisolatie), en via de
cloud-relay geeft de devkit-upload een 400. Er is niets veranderd. Eufy thuis is
nog steeds onbereikbaar. Op verzoek van Tarik geen haast: dit gebeurt een andere
dag.

**AGENTS.md en `.homeyignore`.** Er stond een onbekende `AGENTS.md`. Die was op
2026-10-02 gemaakt, vermoedelijk door Codex, en was een hernoemde kopie van
CLAUDE.md (al verouderd). Op Tariks verzoek is hij verwijderd: Codex leest
CLAUDE.md volgens de globale regel. Bij het uitzoeken bleek dat het app-pakket
alles meenam, ook `private/` met de referentielijst van het huis. Er is nooit
iets met `private/` erin geïnstalleerd: de upload van 10-03 mislukte, en de
installatie op kantoor gebeurde eerder. Nieuwe `.homeyignore`; build en
validate gecontroleerd. Daarmee is het open security-punt `.homeyignore` dicht.

**Volgende sessie (thuis):** v0.6.2 op de Pro installeren (alleen op het LAN),
de Anthropic-sleutel laten plakken, en FlowMind de review-vraag stellen zonder
hint. Het antwoord scoren tegen de referentielijst en daarna FlowMind
verbeteren voor veel flows.

## Sessie 10 — 2026-10-05, avond — thuis: keuken- en achtertuinflow kapot

Geen FlowMind-code. Tarik meldde dat de keukenknop en de achtertuinschakelaar
hun flows niet meer starten. Hij dacht aan Zigbee. Alles is onderzocht met de
API-sleutel via de cloud-relay, eerst alleen lezend: Insights-tijdlijnen,
Zigbee-`lastSeen` per node, en een live luisterscript terwijl Tarik zelf drukte.

**Zigbee was het niet.** Beide schakelaars kwamen gewoon binnen. Het waren twee
losse problemen.

**Achtertuin: de Govee-app hing.** De app draaide nog en was niet gecrasht. Een
"aan"-commando via de flowkaart liep na 10 s af en werd pas minuten later
uitgevoerd. Om 17:49 werkte het nog wel. Na een herstart van de app reageerden
de lampen binnen 1 s op de schakelaar. Vermoeden, niet bewezen: de app vraagt
elke 60 s de status op van 19 lampen, en Govee staat 10.000 verzoeken per dag
toe. Het voorstel om dat naar 5 minuten te zetten ligt nog bij Tarik. De
auto-modus van Claude Code blokkeerde het herstarten via de API. Tarik zette de
sessie op bypass permissions.

**Keuken: de Aqara-app maakt geen triggers meer van de H1-dubbelknop.** De
Aqara-app werd die middag om 16:36 automatisch bijgewerkt naar 1.18.0. Gisteren
om 23:40 werkte de knop nog. De Zigbee-frames komen aan, maar een tijdelijke
testflow met alle 8 triggervarianten (alleen tijdlijnmeldingen) vuurde geen
enkele keer. Die testflow is daarna verwijderd. De groep en de Innr-lampen zijn
bewezen in orde: uit en aan via de flowkaarten, en Tarik zag het gebeuren. Ook
opnieuw koppelen hielp niet. Het nieuwe apparaat heet "Keuken lichten switch".
De keukenflow is omgebouwd: links, rechts of beide 1x ingedrukt doet nu
`toggle` op de groep. De oude versie had twee gelijke triggers met tegengestelde
condities, en die raceten (aan-uit-aan staat in Insights). Back-up van de oude
versie: `private/backups/`.

**Fout van Claude:** `getAppStd` aangeroepen in de veronderstelling dat het
logs leest. Het verstuurt een diagnoserapport naar de app-ontwikkelaar. Er gingen
er 5 naar Govee en Aqara. Tarik is het verteld; de les staat in CLAUDE.md.

**Eufy thuis** koppelt nog steeds niet. Tarik probeerde het opnieuw, zonder
resultaat.

**Voor FlowMind:** een vastgelopen app die nog "draait" is onzichtbaar voor
`check_flows`. Een flowkaart die op een time-out loopt, verraadt het wel.

**Volgende sessie (overdag, de baby sliep):** een ander Aqara-knopmodel testen
(zolder), zodat we weten of heel 1.18.0 stuk is of alleen de H1-dubbel. Tarik
meldt het probleem bij de Aqara-ontwikkelaar, en daarna opnieuw testen na een
update. Besluiten over het Govee-poll-interval. Uitzoeken waar het koppelen van
Eufy misgaat.

---

## Sessie 11 — 2026-10-07 — kantoor: accounts op orde, daarna v0.7.0

**Keukenknop thuis werkt weer vanzelf.** De Aqara-app staat inmiddels op
**1.18.1**, en de Homey is niet herstart (uptime ~8 dagen). De
auto-update repareerde dus wat 1.18.0 brak. De zoldertest is niet meer nodig.

**Eufy: het was geen gedeeld account.** Tarik dacht dat beide Homeys
hetzelfde account gebruikten. De app-instellingen lieten iets anders zien:
thuis logt in als `tarik.polat.2576@gmail.com`, kantoor als
`tarik-polat@live.nl` (het hoofdaccount, dat beide huizen ziet). Daardoor stond
op de kantoor-Homey de camera **"Entree" van thuis** (zelfde serienummer, aan de
HomeBase thuis). Tarik had op kantoor een nieuwe camera "Entree" opgehangen, en
bij het koppelen is de verkeerde gekozen. Beide Eufy-apps crashten die dag om
beurten ("Memory Warning Limit Reached" op kantoor, 47→49 crashes thuis).
- Kantoor logt nu in als `admin@nuvrachtwagen.nl`, dat alleen lid is van huis
  NUvrachtwagen.
- De verkeerde Entree is met Tariks akkoord van de kantoor-Homey verwijderd.
  Geen flow gebruikte hem.
- De nieuwe camera heet "Gang1" en hangt aan zijn eigen station.
- Bjorns NAS gebruikt `nusoftapp070`, volgens Bjorn. Dat staat los van de
  Homeys.
- Of het crashen thuis stopt, moet de komende dagen blijken. De teller stond
  op 49.

**SwitchBot op kantoor.** De app was nooit ingelogd, wat "Invalid Token" gaf
bij de scènelijst. Na inloggen als admin@ (Admin-lid van huis Kantoor) zag
Homey **0 scènes**. De SwitchBot-API geeft alleen scènes van het account zelf.
Scènes die admin@ als lid maakte, kwamen zelfs bij de eigenaar terecht: ze
verschenen op de Homey thuis. Een huis overdragen kan in SwitchBot niet.
Opgelost doordat admin@ een eigen huis kreeg met de kantoorapparaten erin. Nu
ziet de kantoor-Homey alle 4 tv-scènes. Tarik heeft "Test Flow Kantoor"
daarna zelf omgezet naar de nieuwe scènes.

**Tapo-camera op kantoor** (192.168.68.117, TP-Link) wordt niet gevonden door
de officiële Tapo-app. Die ondersteunt niet elke camera. Advies: Third-Party
Compatibility aanzetten, anders de ONVIF-app met een cameraccount. Nog niet
afgerond.

**Eufy-alarm kantoor:** de HomeBase 2 is via Homey al te bedienen
(beveiligingsmodus, sirene, volume, trigger "Arm Mode changed"). Een keypad is
alleen nodig voor bediening met pincode zonder app. De buitensirene hangt aan
de HomeBase 2 en is niet als los Homey-apparaat te koppelen. Een test om te
horen of hij meegaat met het HomeBase-alarm wilde Tarik niet.

**v0.7.0.** Tarik gaf de opdracht om FlowMind zelf verder te verbeteren en te
pushen zonder tussendoor toestemming te vragen.
- **Webterminal:** de vier open security-punten zijn dicht. Het token gaat
  alleen nog in de header, de link zet het in de #fragment, er is een
  `Host`-allowlist tegen DNS rebinding, security-headers, en een knop "Nieuwe
  link" die het token roteert. De `/api/chat` is begrensd: 3 tegelijk, 30 per
  10 min. Provider en model van de client gaan door een allowlist. Daarbij
  bleek een echte bug: koos je in de chat een andere provider, dan ging het
  opgeslagen model van de vorige provider mee (een Claude-id naar Gemini). Ook
  de comment in `webTerminal.js` vertelt nu eerlijk wat de poort geeft.
- **Providers:** de default is Anthropic. Zen vraagt een sleutel en de
  "gratis"-belofte is weg uit de UI, de README en de welkomsttekst. De
  modellenlijsten zijn bijgewerkt (zie CLAUDE.md voor het waarom): OpenAI
  `gpt-5.5`, Gemini `gemini-3.8-flash` (2.5 stopt deze maand), Zen `kimi-k3`.
  De Gemini-key gaat nu in een header in plaats van de URL.
- **`check_flows`:** nieuwe meldingen `device_unavailable` (noemt de app als
  die gecrasht is) en `stale_argument` (scène, gebruiker, variabele of speaker
  bestaat niet meer volgens de app zelf), plus `autocompleteErrors`. Precies het
  SwitchBot-geval van vandaag, dat Homey zelf "gezond" noemt.

**Getest:**
- Alle bestanden met `node --check`, validate `publish` geslaagd.
- De webterminal lokaal met een nep-app: Host-check, header versus query,
  verkeerd token, 429 en token-rotatie gaven allemaal de verwachte status.
- `_resolveProviderAndModel` en de limieten los getest.
- `check_flows` draaide tegen de echte data. Kantoor: 2 flows, niets mis
  (klopt). Thuis: 45 flows in ~5 s, met verdwenen apparaten, "Google Tv
  Woonkamer" onbereikbaar, "NestMini3262" niet meer aangeboden in "Alarm
  activeren", en de Tuya-app die zijn scènes niet kan ophalen.
- v0.7.0 geïnstalleerd op kantoor. De link heeft nu de vorm `/#token=…`. Live
  gaf `?token=` 403, de header 200 en een vreemde host 403. Eén echte chat ("Werken
  al mijn flows nog?") gaf in 10 s het juiste antwoord via `check_flows`.
- Niet getest: OpenAI en Gemini (geen key).

**Gezien, niet aangepast:** in "Test Flow Kantoor" lijken twee kaarten
verwisseld. 1x drukken zet na 1 minuut nog eens "TV entree Aan" aan, en 2x
drukken (uit) zet "TV wachtkamer **aan**". Vermoedelijk hoort 1x "TV wachtkamer
aan" te geven en 2x "Tv wachtkamer Uit". Voorgelegd aan Tarik.

**Review door Fable.** Geen ernstige fouten. Vijf kleine punten waren raak en
zijn verwerkt:
- de terminal liet de providerkeuze leeg als de opgeslagen provider geen key
  had;
- een nieuwe `#token=`-link in hetzelfde tabblad laadde de pagina niet
  opnieuw;
- de naamzoekopdrachten van `check_flows` hebben nu een eigen budget, en de
  hele lookup-ronde maximaal 15 s;
- een app die de zoekterm negeert geeft "niet gecontroleerd" in plaats van een
  mogelijk vals `stale_argument`;
- een opgeslagen model van een andere provider wordt nooit meer meegestuurd.

Voor punt 4 is nagemeten dat alle 7 soorten lijsten thuis wél op de zoekterm
filteren, dus het vangnet gaat daar niet af. Opnieuw geïnstalleerd op kantoor
en nagetest.

Er stond weer een ongetrackte, verouderde `AGENTS.md` (gemaakt door Codex,
nog met Zen als default). Codex geeft die voorrang boven CLAUDE.md. Hij is
verplaatst naar `private/backups/AGENTS.md.stale-2026-10-07` (niet in git).

**Commits:** `3e6c526` (v0.7.0), gepusht naar `origin/main` met akkoord van
Tarik voor deze sessie. Dezelfde push nam ook de lokale log-commits van 3 tot 5
oktober mee (`07d636d`, `3b4dce3`, `5d37c47`).

**Volgende sessie:**
- **Kantoor:**
  - Laat Tarik "Test Flow Kantoor" nalopen (de verwisselde tv-kaarten).
  - Koppel de Tapo-camera: eerst Third-Party Compatibility, anders ONVIF.
  - Bouw het kantooralarm als advanced-flow-test voor FlowMind, met
    HomeBase 2 en "Arm Mode changed".
- **Thuis**, alleen als de pc de Homey op het LAN ziet:
  - Installeer v0.7.0 (CLI terug op "Homey Pro van Tarik").
  - Kijk welke provider en welk model daar opgeslagen staan.
  - Doe de review-test zonder hint tegen
    `private/referentielijst-thuis-2026-10-01.md`.
  - Bekijk "NestMini3262" in "Alarm activeren" en de Tuya-scènes, die niet
    meer opgehaald kunnen worden.
- Eufy thuis: kijk of de crashteller (49 op 2026-10-07) stilstaat nu kantoor
  niet meer aan de HomeBase thuis hangt.
- Nog steeds open: tests 6/7/8, de minimale scopes van de API-sleutel, en een
  Responses-API-pad voor OpenAI (alleen als iemand OpenAI gaat gebruiken).

---

## Bijlage — testgeschiedenis en openstaande security-punten

Verplaatst uit `CLAUDE.md` op 2026-08-08. CLAUDE.md houdt de blijvende lessen,
dit bestand het verloop; hieronder de chronologie die daar niet thuishoort.

### Teststand per 2026-07-21/22 (v0.3.1)

Getest op Tarik's Homey Pro (Early 2023, fw 13.3.0), elke uitkomst gecontroleerd
tegen de Homey API zelf.

| # | Test | Status |
|---|------|--------|
| 1 | Chat zonder API-key (Zen/big-pickle) | ✅ |
| 2 | Device aansturen (stekker uit én aan) | ✅ |
| 3 | Geheugen over gesprekken heen | ✅ (nachttest 2026-07-22) |
| 4 | Standaard flow maken via chat | ✅ v0.3.0 (met API-sleutel) |
| 5 | Advanced flow maken + bewerken via chat | ✅ v0.3.0/0.3.1 (incl. auto-backup) |
| 6 | Flow-kaarten `ai_do` / `ai_ask` | ⏳ risico: flow-timeout, maxSteps 6 |
| 7 | Insights | ⏳ |
| 8 | Moods (`moods.setMood` nooit live getest) | ⏳ |
| 9 | NL-vertaling van de settings-pagina | ✅ |
| 10 | Pushmelding via autocomplete (`push_text` + user) | ✅ v0.3.1, push kwam aan op telefoon |

Gevonden en opgelost in de v0.2.x-sessie: de 10s-timeout, het waarde-type bij
`control_device`, twee hardcoded Nederlandse labels, en Markdown die niet
gerenderd werd.

**v0.3.0:** API-sleutel-setting + lokale API-client met fallback; invoerveld
groeit mee met de tekst (max ~8 regels) en het chatvenster is hoger op brede
schermen (media query ≥900px); het "Scripts uitvoeren"-advies bij een mislukte
flow vervangen door de juiste instructie (API-sleutel instellen), zowel in de
systemprompt als in de foutmelding van `executeTool`.

**v0.3.1** (lessen uit test 4/5): tool `search_flow_card_autocomplete`;
dropdown-argumenten tonen hun `values` in `list_flow_cards`; systemprompt
uitgebreid met pushmelding vs tijdlijn, autocomplete-plicht en de
`start`-kaart-eis voor handmatig startbare advanced flows.

**v0.4.0 — terminal-UI + attitude:** settings-pagina volledig terminal-stijl
(donker, monospace, `❯`-prompt, secties als `[ instellingen ]`), statusregel
onder de composer (provider · model · lokaal ✓ + verstreken seconden), kopregel
met verbindingsstatus. Live actielog via een realtime `chatStep`-event
(`onStep`-callback in `runAssistant` → `homey.api.realtime`). Client-side
slash-commando's `/clear`, `/help`, `/memories`. Persoonlijkheid in de
systemprompt: droog, kort, licht eigenwijs; géén persoonlijkheid in
`[flow]`-runs. Bijna-incident: het model verzon 17 device-UUID's en vuurde er
blind commando's op af (alle faalden toevallig op Not Found).

**Nachttest 2026-07-22 (v0.5.3/0.5.4, via de webterminal):** test 3 ✅,
`/help`, `/memories` en token-403 ✅. Incident met een verzonnen device-UUID in
advanced-flow-kaarten → fix `_assertDeviceCardsExist` in v0.5.4. Retry daarna:
flow correct, Homey-status klapte om (uit 23:13:27Z, aan 23:13:49Z) — maar de
fysieke Govee-lamp deed niets; Tarik zat ernaast. v0.5.3 bracht vertraagde
acties via een tijdelijke flow met delay en opruimen na afloop.

### Security-review 2026-07-22 — openstaande punten

**Stand 2026-10-07:** alle punten hieronder zijn dicht, `.homeyignore` sinds
2026-10-03 en de rest in v0.7.0 (zie sessie 11 en CLAUDE.md).

Uitgevoerd terwijl de Homey offline was; bevindingen met "bewezen" zijn lokaal
nagespeeld met Node, niet beredeneerd. De `run_script`-conclusie staat in
`CLAUDE.md`, want die is blijvend.

- **Webterminal.** Comment eerlijk maken, `Host`-header valideren tegen
  DNS-rebinding, token liever niet in de URL-query laten staan.
- **Geen rate limiting op `/api/chat`** → een token-houder kan turns in een lus
  vuren (kost API-credits, belast de Homey).
- **`startChat` accepteert `provider`/`model` van de client** — onnodig; haal ze
  uit settings.
- **Geen `.homeyignore`** → `CLAUDE.md`, `.github` en `README` gaan mee het App
  Store-pakket in.

Geverifieerd in orde: geen secrets in de git-historie (`.gitignore` heeft
backstops); XSS correct afgehandeld (webterminal bouwt alles met `textContent`,
settings-pagina escapet de ene `innerHTML` via `esc()`); keys gaan nooit terug
naar de client (alleen `keysSet`-booleans); memories, flow-backups en chat-jobs
zijn alle drie begrensd.

Werkwijze bij bevindingen/fixes: versie bumpen (app.json + package.json),
valideren, committen; pushen alleen na toestemming.
