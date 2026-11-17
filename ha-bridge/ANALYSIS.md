# Aula-analyse med den eksisterende OpenClaw-forbindelse

Analysen tilføjes til Aula Bridge uden nye credentials, netværksporte eller Python-afhængigheder.
OpenClaw send_message bruger agent_id main og en unik agent-scoped session pr. kildeversion.
Svar modtages via openclaw_message_received og valideres før videre behandling.

## Drift

- Deaktiveret ved første opstart. Aktivér med aula_bridge.analysis_control, enabled: true.
- Nye skoleopslag og beskedtråde kontrolleres hvert 10. minut fra installationstidspunktet.
- Familiekontekst gives via analysis_control config og gemmes kun i HA Store. Opdatér den ved klasseskift.
- Konkrete opgaver giver straks en kort besked til begge telefoner.
- Relevant orientering leveres ved næste kontrol mellem kl. 18 og 19. Én besked pr. kilde.
- Ingen relevans giver ingen push. Ingen ekstra AI-kørsel bruges til orienteringsbeskederne.
- Fuld analyse vises som en vedvarende HA-notifikation. Telefonens link åbner Aula-dashboardet.
- Private tråde med få modtagere eller markeret følsomt indhold får altid en neutral pushtekst.
- Ulæselige bilag, ugyldigt svar eller for stor kilde giver en neutral besked om manuel gennemlæsning.
- Testhandling analysis_test kræver kind: post/thread og source_id som heltal. Sender aldrig push.
- analysis_status returnerer historik, resultater og fejl. analysis_run henter nye kilder manuelt, hvis aktiveret.
- Slå fra med analysis_control enabled: false. En igangværende analyse kan afslutte i HA, men sender ikke push.

Historik og indstillinger gemmes med HA Store og overlever genstart. Expirerende URL'er og læsemarkeringer
indgår ikke i kildehash. En ny version får ny analyse; identiske notifikationstekster og opgaver gentages ikke.
Et job, som blev afbrudt under genstart, markeres til manuel kontrol og genafsendes ikke til AI automatisk.
Der sendes en ny, unik session for hver modelkørsel. Ingen modelværktøjer anmodes brugt.
Den eksisterende OpenClaw-integration skal fortsat have serviceudførelse deaktiveret.

## Konkrete begrænsninger

- Historiske opslag og beskeder fra før installationen bliver ikke masseudsendt. De kan testes enkeltvis.
- Opslagets publiceringsdato bruges til afgrænsning; redigeringer af opslag fra før installationen opdages ikke.
- Nye svar i gamle tråde opdages via seneste beskeds tidspunkt og id.
- Opslag uden skoleangivelse overlades til relevansvurderingen. Andre institutioners beskeder fravælges efter den konfigurerede institutionskode.
- PDF'er tekstlæses i den eksisterende Aula-gateway. Fotos, scannede PDF'er uden tekst, Word og andre filtyper
  kræver manuel læsning; løsningen påstår ikke at have læst dem.
- Tråde læses sidevis til en tom side. Bilagsværktøjet understøtter kun første trådside; ældre bilag markeres.
- Der hentes højst 100 sider. Grænsen og kildefejl giver synlig kontrolbesked i HA.
- Telefonlevering gemmes før kaldet for at undgå dubletter efter nedbrud. Fejl genafsendes ikke automatisk.
  Leveringsfejl fremgår af den gemte historik. En accepteret HA-notify-handling beviser ikke visning på telefonen.
- Modelleverandør, abonnement og pris styres af den eksisterende OpenClaw-opsætning og er ikke ændret her.
- Tidspunkter bruger Europe/Copenhagen. Kilder og telefoner skal verificeres i den rigtige HA-runtime.

## Validering og tilbageførsel

Kør python3 -m unittest discover -s ha-bridge/tests -p 'test_analysis.py' -v.
Testene bruger syntetiske kilder og HA-stubs; de erstatter ikke livekontrol.
De øvrige eksisterende integrationstest skal også køres før installation.

Ved tilbageførsel: stop analysen, gendan __init__.py og services.yaml fra basecommit
10c9353d0f0309559e29c112f66032877be65de5 og genstart HA. analysis.py kan blive liggende inaktivt.
Historikken i HA Store kan bevares. Aula-login og gatewayen ændres ikke.
