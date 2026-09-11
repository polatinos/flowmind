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

## Sessie 9 — 2026-09-05 — v0.6.1: de app zweeg over zijn eigen blokkade

Tarik meldde dat FlowMind "geen flows kan maken en het totaal niet goed ziet".
Eén screenshot maakte alles duidelijk, en het waren twee problemen tegelijk.

**Wat er te zien was.** Onderin de chat stond `basis — geen flow-schrijfsleutel`
(er was dus geen `homeyApiKey` gezet), en toch was de assistent een webhook-flow
voor de achtertuin aan het ontwerpen: hij vroeg welke event-naam en welke van de
vijf achtertuinlampen uit moesten. Daaronder stond
`HTTP 429: Rate limit exceeded ... [30s]` van het gratis Zen-model.

**De echte fout.** Niets vertelde het model dát flow-schrijven geblokkeerd was —
`SYSTEM_PROMPT` is een constante en alleen memories werden geïnjecteerd. Het
model kon het pas ontdekken door een flow-tool aan te roepen, dus het voerde
eerst een heel ontwerpgesprek en liep daarna pas tegen "Missing Scopes".

**v0.6.1** (commit `c54f6f7`):
- `HomeyContext.getFlowWriteStatus()` — verbindt indien nodig en meldt of
  schrijven kan, met onderscheid tussen 'no_key' en 'key_failed' zodat een
  gebruiker die de sleutel al heeft niet te horen krijgt "maak er een".
- `runAssistant` zet die status in de systemprompt, met de opdracht het in de
  eerste zin te zeggen en níét te gaan ontwerpen of doorvragen.
- `executeTool` weigert de zes flow-schrijftools meteen (`FLOW_WRITING_TOOLS`)
  in plaats van na een mislukte API-ronde.
- `requestJson` wacht een 429 uit en probeert opnieuw; wachttijd uit
  `Retry-After` of uit de `[30s]` in de melding. Is de gevraagde wachttijd
  lánger dan 30s, dan wordt er niet gewacht maar meteen gefaald (dus geen
  cap op 30s — helemaal niet wachten). Alleen 429.
  Chat-beurten zijn achtergrondjobs dus het wachten is onzichtbaar;
  flow-kaarten krijgen `retry: { attempts: 0 }` via `fromFlow: true`, want die
  hebben dat tijdsbudget niet.
- Settings-pagina vertaalt een overgebleven 429/401 naar een bruikbare zin
  (nieuwe keys `errRateLimited`, `errAuth` in EN + NL).

Geverifieerd met een scratch-script: 19 checks, inclusief echte sockets voor de
retry (429→200, budget-cap, `attempts: 0`, 500 niet retryen) en de guard in
beide faalmodi. `validate --level publish` slaagt, EN/NL-keys gelijk (66).

**Bevestigd: de Missing Scopes-grens geldt voor élke client.** Om te helpen
zonder sleutel is geprobeerd de gewenste webhook-flow zelf aan te maken via
Athoms eigen Homey-MCP-connector — een compleet andere OAuth-client, met Tarik
ingelogd. Resultaat: exact dezelfde **"Missing Scopes"**. Lezen en `start_flow`
werken daar wél. Dat is dus geen FlowMind-bug en er is geen omweg; de les staat
nu in `CLAUDE.md`.

Uit de flows die daarvoor gelezen zijn (`webhook`, `achtertuin verlichting`)
kwamen wel de echte kaart-ID's, mocht die flow later alsnog gebouwd worden:
trigger `homey:manager:logic:webhook` (arg `event`), en de vier uit-kaarten
`homey:device:{f3dfab30…,f6aa8538…,b1e74633…,2e2dd2ef…}:off`.

**Review door Fable 5, en v0.6.2.** Fable kreeg de commit ter review en vond
twee echte gaten — allebei in precies het stuk dat v0.6.1 zou repareren, en
allebei bewezen met een eigen probe-script tegen een nagebootste Homey in
plaats van beredeneerd:

- **Een foute sleutel werd gemeld als "werkt".** `HomeyAPI.createLocalAPI`
  doet alleen een *onge­authenticeerde* `GET /api/manager/system/ping` en kijkt
  of er een `X-Homey-ID`-header terugkomt — het token wordt nooit geprobeerd.
  Elke niet-lege string leverde dus `apiMode: 'local'`, `canWrite: true` en een
  groen vinkje in de instellingen, waarna élke aanroep (ook lezen!) faalde met
  "Invalid Token". De `key_failed`-tak was alleen bereikbaar als de Homey
  onbereikbaar was, niet als de sleutel fout was. Fix: `init()` doet na
  `createLocalAPI` één geauthenticeerde call, `api.sessions.getSessionMe()` —
  die staat in de spec op `scopes: []`, dus hij slaagt bij élke geldige sleutel
  ongeacht rechten en faalt alleen als het token zelf geweigerd wordt.
- **Een tijdelijke storing bleef plakken.** `_ensure()` roept `init()` alleen
  aan als `this.api` null is, dus na één mislukte local-poging bleef het bij
  app-modus tot een settings-save of herstart — en v0.6.1 zette dat oordeel
  vervolgens in élke systemprompt. Op déze Homey (die wegvalt onder
  geheugendruk) betekende dat urenlang "controleer je sleutel" voor een
  sleutel die niets mankeert. Fix: `getFlowWriteStatus()` probeert het opnieuw,
  hooguit eens per `LOCAL_RETRY_COOLDOWN_MS` (5 min), kosten één ping.

Verder uit die review verwerkt: het wachten heeft nu een **gedeeld budget per
beurt** (`retry.budget`, 60s) — losse caps van 30s konden over tien tool-stappen
optellen tot voorbij de 5-minutengrens van de instellingenpagina; `flowWrite.error`
wordt platgeslagen en op 200 tekens gekapt vóór het de systemprompt of een
toolresultaat in gaat (bewezen: een `\n\n## IGNORE ALL PREVIOUS INSTRUCTIONS`
in de fouttekst wordt geen eigen kopregel meer); de `rate_limit_wait`-regel in
het live actielog krijgt via `onRetryDone` een afsluitende `ok` in plaats van
eeuwig "running" te blijven; en de mislukte local-client wordt netjes
`destroy()`'d in plaats van te blijven hangen.

Eén punt is na controle **verworpen**: Fable meldde dat `SESSIONS.md` een
niet-bestaande commit `c54f6f7` noemt. Die staat er wel degelijk — op de
werkbranch, niet op `main`, waar Fable keek.

Fable's kritiek op de eerste testronde was terecht en is verholpen: die stubte
`init()` en kón de sleutelbug dus niet zien ("de broken-key-test asserteert
tegen zijn eigen stub"). De nieuwe suite draait de **echte** `init()` tegen een
nep-Homey over echt HTTP: 10 checks, waaronder een geweigerd token, herstel na
de cooldown, geen herverbindingen zonder sleutel, en het beurtbudget. Samen met
de bestaande suite: 29 checks groen.

**Tweede reviewronde door Fable, en v0.6.3.** Fable kreeg v0.6.2 terug met de
vraag zijn eigen bevindingen te verifiëren. Alle vier de fixes hielden stand
(bewezen met probes tegen de échte `homey-api`-client), maar er kwam één nieuwe
fout uit — geïntroduceerd door de fix zelf:

- **De herstelpoging sloopte de werkende verbinding vóórdat er een vervanger
  was.** `reset()` nult `this.api` en pas daarna bouwt `init()` een nieuwe
  client. Faalt `createAppAPI` op dat moment — drie core-calls op een Homey die
  al onder druk staat — dan blijft `this.api` null en faalt élke tool in die
  beurt met een `createAppAPI`-fout. Fable's probe reproduceerde dat.
  Fix: `_buildLocalApi()` bouwt en verifieert zónder `this.api` aan te raken,
  `_retryLocalApi()` wisselt pas om als de nieuwe client bewezen is. Daarmee
  verviel ook zijn punt 2 (`this.api` kortstondig null → een gelijktijdige
  flow-kaart of webterminal-beurt zou dubbel verbinden).
- **Punt 4 (kosmetisch) meegenomen:** `getApiStatus()` is synchroon en triggerde
  de hersteltimer niet, dus de statusregel in de instellingen bleef na een
  storing een oude fout tonen. `getConfig` gaat nu via `_refreshedApiStatus()`.

**Punt 3 kon niemand hier beslissen:** of een échte Homey `/session/me` serveert
voor een API-sleutel. Alles op één na wijst de goede kant op (de spec komt uit
de firmware en de `Session.type`-enum kent `PAT` expliciet; de echte client
stuurt aantoonbaar `GET /api/manager/sessions/session/me` met `Bearer`), maar
een verkeerde aanname zou élke sleutelhouder degraderen. Daarom is de check nu
**fail-soft**: alleen 401/403 (of een expliciete auth-fout in de tekst) geldt
als "sleutel geweigerd"; komt de verbinding tot stand maar mislukt de controle
anders — 404 op onbekende firmware bijvoorbeeld — dan wordt de sleutel
vertrouwd, precies zoals vóór de check. Getest met een nagebootste Homey die
404 geeft. Blijft openstaan: één keer live bevestigen met `app run --remote`.

Fable trok zijn punt 7 (de "niet-bestaande" commit `c54f6f7`) zelf in na
controle van de reflog: hij keek tijdens de eerste ronde naar `fa606dc`, dat
één minuut later is geamend.

Testsuite herschreven op zijn kritiek: geen vaste poort meer, de
`Authorization`-header en het exacte pad worden nu geasserteerd, "binnen de
cooldown" telt echte requests in plaats van alleen de status, en er zijn tests
bij voor de twee nieuwe scenario's (mislukte herverbinding behoudt de werkende
client; `this.api` is nooit null tijdens een herverbinding) en voor de
404-firmware. 15 checks, plus de 19 bestaande.

**De sleutel was er ooit wél — waar is hij gebleven?** Tarik meldde aan het eind
van de sessie dat hij "alles al gedaan" had. Dat is geloofwaardig: op
2026-07-21 zijn er met een sleutel echt flows aangemaakt (twee keer
onafhankelijk geverifieerd). De statusregel zei nu `basis — geen
flow-schrijfsleutel`, dus de sleutel is **verdwenen**, niet nooit ingevuld.

Nagekeken in de code: de app kan de sleutel niet per ongeluk wissen.
`saveConfig` wist alleen bij een expliciete `clearHomeyApiKey: true` (de knop
"Verwijder sleutel"); een leeg invoerveld laat de opgeslagen sleutel met rust,
en de settings-pagina leegt dat veld ná opslaan met opzet.

**Waarschijnlijke oorzaak (hypothese, niet geverifieerd):** `npx homey app run`
installeert de app *tijdelijk* — stopt het proces, dan verdwijnt de app en
daarmee álle app-settings, inclusief `homeyApiKey`. Alleen `npx homey app
install` is permanent. Dat past precies op "werkte in juli, weg in september".
Te bevestigen door na een `app install` de sleutel te zetten en te kijken of
hij een herstart overleeft.

**Volgende sessie — dit als eerste, in deze volgorde:**
1. `npx homey app install` (niet `app run`) zodat de app permanent staat.
2. Sleutel maken op my.homey.app → Instellingen → Systeem → API-sleutels,
   plakken in FlowMind → Opslaan.
3. Statusregel controleren: moet `lokaal ✓` worden in plaats van `basis`. Sinds
   v0.6.2 is dat vinkje betrouwbaar — het verschijnt alleen na een
   geauthenticeerde call.
4. Pas dan de flow-test: de webhook-flow voor de achtertuin. Kaart-ID's staan
   hierboven.
5. Meteen daarna live bevestigen wat hier niet te bevestigen was: serveert de
   echte Homey `/session/me` voor een API-sleutel? Zo niet, dan valt de app
   terug op vertrouwen (fail-soft) en is er niets stuk — maar dan hoort de
   check aangepast te worden.

Verder onveranderd openstaand: tests 6/7/8, `check_flows` live, en de vier
security-punten in de bijlage.

**Testscripts van deze sessie** stonden in de scratch-map en zijn dus weg
(29 checks over de retry/guard, 15 over de verbinding, 8 end-to-end van
"geen sleutel" tot een geposte flow). Als die verificatie herhaalbaar moet
zijn, horen ze in de repo — dat is een bewuste afwijking van "geen unit
tests" en wacht op Tariks besluit.

---

## Sessie 10 — 2026-09-11 — geen code: de thermostaat die "uit zichzelf" stookte

Geen regel aan FlowMind gewijzigd. Deze sessie ging over Tariks Homey zelf, en
leverde vooral kennis op die anders opnieuw uitgezocht zou worden.

**De klacht.** De Nest-thermostaat (Woonkamer,
`3099be4f-674d-4039-97dd-822fdf32ae25`) ging af en toe uit het niets verwarmen.
Hinderlijk, vooral voor Naomi, die er thuis mee zat.

**Alle 39 flows nagelopen** (15 standaard + 24 advanced) op de thermostaat.
Precies twee raken hem aan, samen drie schrijvende kaarten:

- **`Thuiskomst Auto Nieuw`** (aan), rood blok "Verwarming gedeelte": bij
  thuiskomst → *modus op Verwarmen* + *doeltemperatuur 23°*, maar alleen als
  Naomi níét thuis is, eco aan staat en het binnen < 16 °C is.
- **`Uit huis`** (aan): laatste persoon vertrekt → *Eco inschakelen*. Verlaagt
  dus juist.

Dat pleitte Homey vrij: het ging mis terwijl Naomi thuis wás, en de enige
verwarmende flow vuurt alleen als ze weg is. Bovendien staat nergens in Homey
de 16,5 °C die de thermostaat toonde — Homey zet alleen ooit 23.

**Nest-kant opgevraagd** (door Tarik via Claude-in-Chrome, want deze omgeving
komt niet op nest.com — zie hieronder). Daar zat de oorzaak:

- **Het Nest-weekschema zelf**: elke dag 18:45 → 21 °C, zaterdag/zondag
  19:15 → **24,5 °C**.
- **True Radiant stond aan**: de cv begint uren vóór het schema-tijdstip te
  stoken (max 5 uur 's nachts). Dát is het "uit het niets" — op het moment
  zelf is er geen zichtbare aanleiding.
- **Thuis/Afwezig flipte 3× op één dag**, waardoor eco er steeds afging en het
  schema hervat werd terwijl er wel iemand thuis was.

**Opgelost:** modus op **Uit**, True Radiant **uit**, Thuis/Afwezig **uit**
(veiligheidstemperatuur 4,5 °C blijft actief). Het weekschema staat er nog
ongewijzigd in.

**Losse vondst met gevolgen: de Google Nest-koppeling in Homey was stuk.**
`set_devices_capabilities_values` op de thermostaat gaf twee keer
*"Dit apparaat is nu niet beschikbaar"*, terwijl `list_devices` een
normaal ogende (maar verouderde) state teruggaf — de lijst is dus géén
betrouwbare indicator voor beschikbaarheid. Na een herstart van de Nest-app
door Tarik: `nest_thermostat_mode` sprong van `heat` naar `off` (de wijziging
die net in Google was gemaakt), en een schrijfpoging leverde
`ThermostatEco.SetMode ... [FAILED_PRECONDITION]` — een inhoudelijk antwoord
van Google, dus de opdracht kwam aan. Koppeling hersteld.

**Daardoor is één opruimklus urgent geworden:** zolang de koppeling stuk was,
deed de 23°-kaart in `Thuiskomst Auto Nieuw` niets. Nu kan hij weer vuren.
Die twee kaarten moeten eruit vóórdat de verwarming weer op Verwarmen gaat.

**Overige apparaten met een verbindingsalarm** (`alarm_connectivity: true`):
*Table lamp2 pro*, *Hoeklamp woonkamer*, *Bank led lichten lokaal* — alle drie
Govee. *Voortuin verlichting* kwam er tijdens de sessie vanzelf weer bij, wat
op een haperende Govee-cloud wijst. Verder: **deurbel op 9 % batterij** en de
**luchtreiniger babykamer met een versleten filter** (`alarm_filter_life`).

**Ook bevestigd: Insights valt óók onder Missing Scopes.**
`get_insights_log_entries_number` via de Homey-connector gaf dezelfde fout als
flow-schrijven. Insights uitlezen kan dus alleen via de Homey-app zelf, of via
FlowMind mét API-sleutel.

**Waarschuwing over deze werkomgeving.** De web-omgeving draait achter een
egress-proxy die alleen een smalle lijst hosts doorlaat: GitHub en npm wel,
`google.nl` en `home.nest.com` niet (403 op CONNECT; `/root/.ccr/README.md`
zegt expliciet: niet omheen werken, melden). Chromium ís geïnstalleerd, dus het
is geen browserprobleem maar een netwerkpolicy. Bovendien deelt de gebruiker
zijn browsersessies niet met deze container, dus inloggen op zijn accounts kan
hier sowieso niet. Praktisch: **alles wat een ingelogde website vereist, loopt
via Claude-in-Chrome of via Claude Code lokaal op Tariks laptop.** Tarik laat de
netwerkinstelling van de omgeving verruimen; dat geldt pas vanaf een nieuwe
sessie.

**Aan het eind van de sessie opgelost:** Tarik heeft via Claude-in-Chrome de
netwerkinstelling van de omgeving ("Default Cloud Environment", gedeeld met
zijn andere repo's) van **Trusted** naar **Full** gezet — de opties waren None,
Trusted, Full en Custom. Vanaf de eerstvolgende sessie kan een web-sessie dus
het open web op. Inloggen op zijn accounts blijft onmogelijk; dat blijft
Claude-in-Chrome of lokaal. Zie het bijgewerkte kopje in `CLAUDE.md`.

**Openstaand (onveranderd + nieuw):**
1. `npx homey app install` en de Homey API-sleutel — zie sessie 9, stap voor stap.
2. De twee verwarmingskaarten uit `Thuiskomst Auto Nieuw` verwijderen.
3. Govee-app herstarten (drie lampen in storing).
4. Deurbelbatterij, filter babykamer.
5. Nest-weekschema opschonen als de verwarming weer aan gaat (die 24,5 °C).
6. Tests 6/7/8, `check_flows` live, de vier security-punten in de bijlage.

---

## Sessie 11 — 2026-09-11, avond — v0.6.4: de webterminal dichtgetimmerd

Eerste sessie met netwerktoegang op **Full**: `example.com` geeft 200 en de
Zen-modellenlijst kwam live binnen. Inloggen op Tariks accounts blijft
onmogelijk — dat blijft Claude-in-Chrome of lokaal.

Aangepakt: het enige echte gat uit de security-review van 2026-07-22. Poort
8737 gaf een token-houder op het LAN volledige huisbediening, en de comment
bovenin het bestand beweerde het tegendeel ("chat only, no secrets").

**v0.6.4, alles in `lib/webTerminal.js`:**
- **Token uit de pagina.** De settings-link draagt het token nog één keer als
  `?token=`; `GET /` wisselt het meteen in voor een HttpOnly-cookie
  (`SameSite=Strict`, 30 dagen). De query authenticeert daarna niets meer;
  API-routes nemen alleen de cookie of de `X-FlowMind-Token`-header. Het
  token staat niet meer in localStorage, en de pagina ruimt een oude kopie op.
- **Host-check vóór de auth-check** tegen DNS-rebinding. IP-literals,
  `localhost`, namen zonder punt en `.local/.lan/.home/.internal/.homey` mogen
  erdoor; een publiek registreerbare naam niet.
- **`POST` eist `application/json`.** Een formulier van een andere site kan die
  content-type niet zetten, dus samen met SameSite is cross-site posten dicht.
- **Rate limit op `POST /api/chat`:** 8 beurten per minuut per client, 20
  totaal, `Retry-After` erbij. Alleen chat — lezen blijft werken terwijl er
  geremd wordt, en een geweigerde beurt bereikt `startChat` niet.
- **Body gesnoeid** (`_chatBody`): alleen `messages` (max 40, rollen en content
  gecoerced) plus een provider-id dat écht in `PROVIDERS` staat. `model`,
  `maxSteps` en `fromFlow` komen voortaan uit settings, nooit van het LAN.
  Daarmee is ook het derde punt uit de review afgevangen, op de plek waar het
  telt: `startChat` zelf accepteert ze nog, maar alleen nog van de
  instellingenpagina, die achter Homey's eigen auth zit.
- De comment bovenin zegt nu wat er werkelijk over die poort kan.

**Geverifieerd met een probe tegen de échte server over echte sockets** (geen
stubs, geen redenering): 42 checks, allemaal groen. Daarin onder meer een te
kort token (dat `timingSafeEqual` zou laten gooien), een cookie tussen andere
cookies, acht Host-varianten, `evil.com` mét geldig token, een `text/plain`-post
en de negende beurt binnen een minuut. `validate --level publish` slaagt.

**Nog open uit die review:** alleen `.homeyignore` — `CLAUDE.md`, `.github` en
`README` gaan nu mee het App Store-pakket in.

Onveranderd openstaand: de stappen uit sessie 9 (`app install`, de API-sleutel,
`/session/me` live bevestigen), tests 6/7/8, `check_flows` live, en de vier
Homey-klussen uit sessie 10 (verwarmingskaarten, Govee, deurbelbatterij,
Nest-weekschema).

Het probe-script stond weer in de scratch-map en is dus weg. Dat is nu de
tweede keer; het besluit of dit soort verificatie in de repo hoort ligt nog
steeds bij Tarik.

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

Uitgevoerd terwijl de Homey offline was; bevindingen met "bewezen" zijn lokaal
nagespeeld met Node, niet beredeneerd. De `run_script`-conclusie staat in
`CLAUDE.md`, want die is blijvend.

- ~~**Webterminal.** Comment eerlijk maken, `Host`-header valideren tegen
  DNS-rebinding, token liever niet in de URL-query laten staan.~~ Opgelost in
  v0.6.4 (sessie 11).
- ~~**Geen rate limiting op `/api/chat`** → een token-houder kan turns in een lus
  vuren (kost API-credits, belast de Homey).~~ Opgelost in v0.6.4.
- ~~**`startChat` accepteert `provider`/`model` van de client** — onnodig; haal ze
  uit settings.~~ Afgevangen in v0.6.4 op de webterminal-grens; `startChat`
  accepteert ze nog van de instellingenpagina, die vertrouwd is.
- **Geen `.homeyignore`** → `CLAUDE.md`, `.github` en `README` gaan mee het App
  Store-pakket in. **Nog open.**

Geverifieerd in orde: geen secrets in de git-historie (`.gitignore` heeft
backstops); XSS correct afgehandeld (webterminal bouwt alles met `textContent`,
settings-pagina escapet de ene `innerHTML` via `esc()`); keys gaan nooit terug
naar de client (alleen `keysSet`-booleans); memories, flow-backups en chat-jobs
zijn alle drie begrensd.

Werkwijze bij bevindingen/fixes: versie bumpen (app.json + package.json),
valideren, committen; pushen alleen na toestemming.
