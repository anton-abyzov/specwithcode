import type { Messages } from "./en";

/**
 * German, informal "du". "Thread" for thread, "Anbieter" for provider,
 * "Fallback" for fallback. Both machine nouns (Mac, Rechner) are masculine.
 */
export const de: Messages = {
  "common.sentenceSpace": " ",
  "settings.language.title": "Sprache",
  "settings.language.description":
    "Die Sprache von SpecWithCode auf diesem Gerät. Einige Bildschirme sind noch auf Englisch.",
  "settings.language.system": "System ({language})",

  "wizard.title": "SpecWithCode einrichten",
  "wizard.stage.connect": "Verbinden",
  "wizard.stage.agents": "Agenten",
  "wizard.stage.projects": "Projekte",
  "wizard.close": "Einrichtung schließen",
  "wizard.noun.mac": "Mac",
  "wizard.noun.machine": "Rechner",
  "wizard.computer": "Computer",
  "wizard.continue": "Weiter",
  "wizard.back": "Zurück",
  "wizard.retry": "Erneut versuchen",
  "wizard.closeTerminal": "Schließen",
  "wizard.toast.choiceNotSaved": "Deine Auswahl konnte nicht gespeichert werden",
  "wizard.toast.settingsNotSaved":
    "Deine Einstellungen konnten nicht gespeichert werden. Versuche es erneut.",
  "wizard.toast.historyNotImported": "Ein Teil des Verlaufs wurde nicht importiert",
  "wizard.toast.imported": {
    one: "{count} Thread importiert",
    other: "{count} Threads importiert",
  },
  "wizard.toast.finishFailed": "Einrichtung konnte nicht abgeschlossen werden",

  "wizard.connection.title": "Verbinde deine Computer",
  "wizard.connection.description":
    "Wähle einen oder mehrere Computer. Wir richten auf jedem Agenten und Projekte ein.",
  "wizard.connection.legend": "Einzurichtende Computer",
  "wizard.connection.connected": "Verbunden",
  "wizard.connection.connecting": "Verbinde…",
  "wizard.connection.addComputer": "Computer hinzufügen",
  "wizard.connection.telemetry":
    "Nutzungstelemetrie ist standardmäßig aus. SpecWithCode sendet keine Nutzungsdaten, solange du sie nicht in der Serverumgebung einschaltest.",
  "wizard.connect.loadingSignIn": "Anmeldung wird geladen…",
  "wizard.connect.signIn": "Anmelden",
  "wizard.connect.loadingComputers": "Computer werden geladen…",
  "wizard.connect.noComputers": "Noch keine Computer verknüpft.",
  "wizard.connect.runThis":
    "Führe das auf jedem Computer aus, den du verbinden willst. Dann ist er von deinen anderen Geräten erreichbar, ohne Tailscale oder Portweiterleitung.",
  "wizard.connect.keepRunning":
    "Lass SpecWithCode laufen. Wähle oben die Computer aus, die du einrichten willst.",

  "wizard.pairing.failed": "Kopplung fehlgeschlagen.",
  "wizard.pairing.label": "Kopplungslink",
  "wizard.pairing.need": "Brauchst du einen Kopplungslink?",
  "wizard.pairing.pairing": "Kopple...",
  "wizard.pairing.pair": "Koppeln",
  "wizard.pairing.runThis": "Führe das auf dem Computer mit deinem Code aus.",
  "wizard.pairing.startFirst":
    "Starte zuerst SpecWithCode oder führe {serve} aus. Füge {tailscale} hinzu, um dein Tailnet zu nutzen.",

  "wizard.agents.title": "Verbinde deine Agenten",
  "wizard.agents.description":
    "Wähle einen Agenten, um mit dem Programmieren zu beginnen. Weitere kannst du später hinzufügen.",
  "wizard.agents.noTerminal": "Diese Verbindung kann keine Terminals steuern.",
  "wizard.agents.anotherChatGpt": "Weiteres ChatGPT-Konto verbinden",
  "wizard.agents.readyToCode": "Bereit zum Programmieren.",
  "wizard.agents.ready": "Bereit",
  "wizard.agents.checking": "Prüfe...",
  "wizard.agents.disabled": "Deaktiviert",
  "wizard.agents.signIn": "Anmelden",
  "wizard.agents.install": "Installieren",
  "wizard.terminal.runCommand": "Führe {command} in diesem Terminal aus.",
  "wizard.terminal.review": "Prüfe den Befehl und drücke dann Enter, um ihn auszuführen.",
  "wizard.terminal.openFailed": "Das Einrichtungsterminal konnte nicht geöffnet werden.",
  "wizard.terminal.preparing": "Befehl wird vorbereitet...",
  "wizard.terminal.label": "{driver} installieren",

  "wizard.import.noPermission":
    "Diese Verbindung kann keine Projekte oder Thread-Verläufe importieren.",
  "wizard.import.scanLimit":
    "Suchlimit erreicht. Einige Projekte oder Unterhaltungen fehlen möglicherweise.",
  "wizard.import.importedThreads": {
    one: "{count} Thread importiert.",
    other: "{count} Threads importiert.",
  },
  "wizard.import.skippedThreads": {
    one: "{count} Thread konnte nicht importiert werden.",
    other: "{count} Threads konnten nicht importiert werden.",
  },
  "wizard.import.someHistoryFailed": "Ein Teil des Thread-Verlaufs konnte nicht importiert werden.",
  "wizard.import.historyFailed": "Der Thread-Verlauf konnte nicht importiert werden.",
  "wizard.import.yourProjects": "Deine Projekte",
  "wizard.import.lookingInAgents": "Suche nach Projekten aus Claude Code und Codex…",
  "wizard.import.skip": "Keine Projekte importieren",
  "wizard.import.title": "Wähle deine Projekte",
  "wizard.import.description":
    "Importiere Projekte und Unterhaltungen von den ausgewählten Computern.",
  "wizard.import.selectedCount": "{selected} von {total} ausgewählt",
  "wizard.import.selectAll": "Alle auswählen",
  "wizard.import.selectNone": "Keine auswählen",
  "wizard.import.looking": "Suche nach Projekten…",
  "wizard.import.checkFailed": "Projekte konnten nicht geprüft werden. {error}",
  "wizard.import.none": "Keine vorhandenen Claude-Code- oder Codex-Projekte gefunden.",
  "wizard.import.importing": "Importiere…",
  "wizard.import.importButton": {
    one: "{count} Projekt importieren",
    other: "{count} Projekte importieren",
  },
  "wizard.import.otherFolders": "Andere Ordner",
  "wizard.import.folderCount": { one: "{count} Ordner", other: "{count} Ordner" },
  "wizard.import.now": "jetzt",

  "wizard.role.title": "Wie willst du diesen {machine} nutzen?",
  "wizard.role.changeLater": "Du kannst das später ändern.",
  "wizard.role.main.title": "Als Hauptrechner starten",
  "wizard.role.main.description":
    "Richte auf diesem {machine} Agenten und Projekte ein. Weitere Rechner kannst du später hinzufügen.",
  "wizard.role.join.title": "Mit einem bestehenden verbinden",
  "wizard.role.join.description":
    "Dieser {machine} arbeitet für deinen Hauptrechner an einem anderen Ort. Du verknüpfst hier SpecWithCode Connect und fügst dann eine Zeile auf dem Hauptrechner ein.",
  "wizard.role.later": "Später entscheiden",
  "wizard.role.laterHint":
    "Sieh dich erst um oder aktualisiere. Um später beizutreten, wähle unter Einstellungen > Verbindungen „Einem Hauptrechner beitreten“.",
  "wizard.join.title": "Diesen {machine} mit deinem Hauptrechner verbinden",
  "wizard.join.step1": "Melde dich bei SpecWithCode Connect an und verknüpfe diesen {machine}.",
  "wizard.join.step2":
    "Füge die Umgebungs-ID deines Hauptrechners ein (dort unter Einstellungen > Verbindungen) und erstelle die Zeile.",
  "wizard.join.step3":
    "Füge die Zeile innerhalb einer Stunde auf dem Hauptrechner unter Einstellungen > Verbindungen > Rechner hinzufügen ein.",
  "wizard.join.makeLine": "Zeile erstellen",
  "wizard.join.pasted": "Ich habe sie eingefügt",
  "wizard.joined.title": "Dieser {machine} ist bereit für deinen Hauptrechner",
  "wizard.joined.description":
    "Er ist bereit, sobald du die Zeile auf deinem Hauptrechner unter Einstellungen > Verbindungen > Rechner hinzufügen einfügst. Wähle dort auf seiner Karte „Worker erlauben“, damit Koordinatoren hier Arbeit starten können, und lass die App auf diesem {machine} laufen.",
  "wizard.joined.newLine": "Neue Zeile erstellen",
  "wizard.joined.fullSetup": "Diesen {machine} stattdessen als Hauptrechner einrichten",

  "update.downloadFailed": "Update konnte nicht heruntergeladen werden",
  "update.startFailed": "Update-Download konnte nicht gestartet werden",
  "update.unexpected": "Ein unerwarteter Fehler ist aufgetreten.",
  "update.downloaded": "Update heruntergeladen",
  "update.quitReopen": "Beende SpecWithCode und öffne es erneut, um es zu installieren.",
  "update.productVersion": "SpecWithCode {version}",
  "update.productNewer": "Ein neueres SpecWithCode",
  "update.available": "{product} ist verfügbar. Aktualisiere vor der Einrichtung.",
  "update.downloading": "Update wird heruntergeladen…",
  "update.downloadingPercent": "Update wird heruntergeladen ({percent} %)…",
  "update.lastFailed": "Die letzte Installation ist fehlgeschlagen: {reason}",
  "update.ready": "{product} ist bereit zur Installation.",
  "update.aria": "App-Update",
  "update.download": "Update herunterladen",
  "update.checking": "Prüfe…",
  "update.retry": "Update erneut versuchen",
  "update.restart": "Zum Aktualisieren neu starten",

  "limit.unavailable.missing": "nicht auf diesem Rechner",
  "limit.unavailable.limited": "am Limit",
  "limit.unavailable.signedOut": "abgemeldet",
  "limit.unavailable.perToken": "Abrechnung pro Token",
  "limit.unavailable.full": "ausgeschöpft",
  "limit.unavailable.fullUntil": "ausgeschöpft bis {time}",
  "limit.unavailable.tooSmall": "Kontextfenster zu klein",
  "limit.unavailable.unverified": "kein aktueller Nutzungswert",
  "limit.unavailable.providerWarning": "Warnung des Anbieters",
  "limit.unavailable.notReady": "auf diesem Rechner nicht eingerichtet",
  "limit.unavailable.excluded": "vom automatischen Fallback ausgeschlossen",
  "limit.duration.minutes": "{count} Min.",
  "limit.duration.hours": "{count} Std.",
  "limit.duration.hoursMinutes": "{hours} Std. {minutes} Min.",
  "limit.duration.days": { one: "{count} Tag", other: "{count} Tage" },
  "limit.sentenceJoin": ". ",
  "limit.reset.unavailable": "Zeitpunkt des Zurücksetzens unbekannt",
  "limit.reset.in": "Wird in {duration} zurückgesetzt ({clock})",
  "limit.reset.at": "Zurückgesetzt um {clock}",
  "limit.next.waiting":
    "Das Zurücksetzen steht kurz bevor, daher wartet dieser Thread und macht hier weiter, statt zu wechseln.",
  "limit.next.resumingNow": "Das Limit wurde zurückgesetzt, es geht hier weiter.",
  "limit.next.continuesAtReset": "Dieser Thread macht beim Zurücksetzen von selbst weiter.",
  "limit.next.continuingNow": "Das Limit wurde zurückgesetzt, es geht weiter.",
  "limit.next.byRule": "Weiter mit {label} laut Projektregel.",
  "limit.title.credits": "API-Guthaben aufgebraucht",
  "limit.title.included": "Inklusive Nutzungslimit erreicht",
  "limit.title.usage": "Nutzungslimit erreicht",
  "limit.creditsExhausted":
    "Dieses API-Konto hat kein Guthaben mehr. Lade es auf oder mach mit einem anderen Konto weiter.",
  "limit.error.continueOn": "Weitermachen mit {label} war nicht möglich.",
  "limit.error.resetPassed":
    "Der Zeitpunkt des Zurücksetzens ist vorbei. Starte den Thread manuell neu.",
  "limit.error.recovery": "Die Limit-Wiederaufnahme konnte nicht geändert werden.",
  "limit.error.project": "Die Projekteinstellung konnte nicht geändert werden.",
  "limit.auto.savedHint":
    "Für diesen Thread gespeichert. SpecWithCode setzt den gestoppten Turn von selbst fort, auch nach einem Neustart.",
  "limit.auto.whenUsage": "Automatisch weitermachen, wenn Nutzung verfügbar ist",
  "limit.auto.whenReset": "Automatisch weitermachen, wenn das Limit zurückgesetzt wird",
  "limit.saving": "Speichere...",
  "limit.project.global": "In den Einstellungen für alle Projekte aktiviert.",
  "limit.project.hint":
    "Setzt auch Threads dieses Projekts fort, die bereits auf ein Limit warten.",
  "limit.project.label":
    "Threads dieses Projekts automatisch fortsetzen, wenn Limits zurückgesetzt werden",
  "limit.noReset.withHandoffs":
    "Der Anbieter hat nicht angegeben, wann dieses Limit zurückgesetzt wird, daher kann der Thread nicht von selbst weitermachen. Wechsle jetzt zu einem anderen Modell oder Rechner oder sende nach dem Zurücksetzen eine Nachricht.",
  "limit.noReset":
    "Der Anbieter hat nicht angegeben, wann dieses Limit zurückgesetzt wird, daher kann der Thread nicht von selbst weitermachen. Sende nach dem Zurücksetzen eine Nachricht.",
  "limit.orElsewhere": "Oder jetzt zu einem anderen Modell oder Rechner wechseln:",
  "limit.insteadOfWaiting": "Statt zu warten zu einem anderen Modell oder Rechner wechseln:",
  "limit.fallback.hint":
    "Diesen Thread auf {label} ({model}) umstellen und den gestoppten Turn mit seiner Unterhaltung fortsetzen",
  "limit.fallback.continueWith": "Weiter mit {label} · {model}",
  "limit.otherModelsAria": "Andere Fallback-Modelle",
  "limit.otherModels": "Andere Modelle",
  "limit.chooseModel": "Modell wählen",
  "limit.device.hint":
    "Starte einen Thread auf {label} ({model}) mit einer schriftlichen Zusammenfassung dieser Unterhaltung. Änderungen, die nicht von diesem Gerät gepusht wurden, kommen nicht mit.",
  "limit.device.fresh": "Neu starten auf {label} (nur Zusammenfassung)",
  "limit.device.continue": "Weiter auf {label}",
  "limit.checkRequested": "Prüfung angefordert",
  "limit.checkNow": "Jetzt prüfen",
  "limit.snooze": "Bis zum Zurücksetzen schlummern",
  "limit.check.allowedOn":
    "Die letzte Prüfung erlaubte normale Nutzung; automatisches Weitermachen ist an.",
  "limit.check.allowedOff":
    "Die letzte Prüfung erlaubte normale Nutzung. Aktiviere „Automatisch weitermachen“, um fortzufahren.",
  "limit.check.denied": "Dieses Profil verweigert weiterhin normale Nutzung.",
  "limit.check.changed":
    "Das Konto oder Profil hat sich geändert. Die automatische Wiederaufnahme ist blockiert.",
  "limit.check.reconfirm":
    "Prüfe jetzt, deaktiviere dann „Automatisch weitermachen“ und aktiviere es erneut, um das aktuelle Profil zu bestätigen.",
  "limit.check.unverified":
    "Die Berechtigung zur normalen Nutzung konnte nicht geprüft werden. Der Thread bleibt gestoppt.",
  "limit.approaching.title": "{provider} hat noch {percent} % seiner Nutzung übrig",
  "limit.approaching.question":
    "Diesen Thread auf {label} umstellen, bevor das Limit einen Turn stoppt?",
  "limit.approaching.switch": "Zu {label} wechseln",
  "limit.approaching.notNow": "Nicht jetzt",
  "limit.preswitch.blocked":
    "{model} war fast am Nutzungslimit, daher ist dieser Thread vor seinem nächsten Turn umgezogen. Er bleibt auf dem Fallback: {reason}.",
  "limit.preswitch.hasRoom":
    "{model} war fast am Nutzungslimit und hat wieder Luft. Der ruhende Thread wechselt von selbst zurück.",
  "limit.preswitch.noRoom":
    "{model} ist fast am Nutzungslimit. Der ruhende Thread wechselt von selbst zurück, sobald wieder Luft ist.",

  "fallback.chip.ready": "Bereit",
  "fallback.chip.unverified": "Nutzung unbekannt",
  "fallback.chip.full": "Nutzung ausgeschöpft",
  "fallback.chip.fullUntil": "Ausgeschöpft bis {time}",
  "fallback.chip.limited": "Am Limit",
  "fallback.chip.signedOut": "Abgemeldet",
  "fallback.chip.perToken": "Pro Token abgerechnet",
  "fallback.chip.tooSmall": "Kontext zu klein",
  "fallback.chip.notReady": "Nicht eingerichtet",
  "fallback.chip.missing": "Nicht auf diesem Rechner",
  "fallback.chip.excluded": "Ausgeschlossen",
  "fallback.chip.unknownBilling": "Abrechnung unbekannt",
  "fallback.family": "{family}-Familie",
  "fallback.moveUp": "{label} nach oben",
  "fallback.moveDown": "{label} nach unten",
  "fallback.remove": "{label} entfernen",
  "fallback.sameModelAria": "Gleiches Modell bei anderen Anbietern, nach {label}",
  "fallback.sameModelOn": "Gleiches Modell bei {provider}",
  "fallback.orderLabel": "Fallback-Reihenfolge",
  "fallback.status.ready": "Kann einen limitierten Thread übernehmen",
  "fallback.status.unverified": "Angemeldet, kein aktueller Nutzungswert",
  "fallback.status.current": "Modell dieses Threads",
  "fallback.status.excluded": "Vom automatischen Fallback ausgeschlossen",
  "fallback.status.disabled": "Ausgeschaltet",
  "fallback.status.signedOut": "Abgemeldet",
  "fallback.status.notReady": "Auf diesem Rechner nicht eingerichtet",
  "fallback.status.limited": "Am Limit",
  "fallback.status.full": "Ausgeschöpft",
  "fallback.status.fullUntil": "Ausgeschöpft bis {time}",
  "fallback.status.perToken":
    "Pro Token abgerechnet: nur wenn du es nennst oder API-Guthaben erlaubst",
  "fallback.status.neverAutomatic": "Rechnet über ein Google-Cloud-Projekt ab: nie automatisch",
  "fallback.status.namedOnly": "Abrechnung unbekannt: nur wenn du es nennst",
  "fallback.access.notRead": "Tarifnutzung nicht gelesen",
  "fallback.access.reported": "Tarifnutzung gemeldet",
  "fallback.access.lastRead": "Zuletzt gelesen: {percent} % genutzt",
  "fallback.access.planUsage": "Tarifnutzung: {percent} % genutzt",
  "fallback.access.noUsage": "Angemeldet; Anbieter meldet keine Nutzung",
  "fallback.access.perToken": "Pro Token abgerechnet",
  "fallback.access.unknown": "Zugriff unbekannt",
  "fallback.inOrder": "Nr. {index} in der Reihenfolge",
  "fallback.include": "Einschließen",
  "fallback.exclude": "Ausschließen",
  "fallback.includeAria": "{model} einschließen",
  "fallback.excludeAria": "{model} ausschließen",
  "fallback.providerModels": "Modelle von {provider}",
  "fallback.hideOlder": "Ältere Versionen ausblenden",
  "fallback.showOlder": {
    one: "{count} ältere Version anzeigen",
    other: "{count} ältere Versionen anzeigen",
  },
  "fallback.noProviders": "Noch keine Anbieter auf diesem Rechner.",
  "fallback.footnote":
    "Ein ausgeschlossenes Modell bleibt bei jedem automatischen Wechsel auf jedem Anbieter außen vor; du kannst es trotzdem selbst wählen. Neue Modelle sind erlaubt, bis du sie ausschließt. Der hier gezeigte Zugriff ist nur das, was SpecWithCode sehen kann: GitHub-Actions-Minuten, ein X-Abo oder Startup-Guthaben sind kein Modellzugriff, es sei denn, einer dieser Anbieter ist damit angemeldet.",
  "fallback.summary.models": { one: "{count} Modell", other: "{count} Modelle" },
  "fallback.summary.ready": "{count} jetzt bereit",
  "fallback.summary.excluded": "{count} ausgeschlossen",

  "limitSettings.mixed": "Gemischt",
  "limitSettings.cancel": "Abbrechen",
  "limitSettings.action.ask": "Fallback anbieten",
  "limitSettings.action.wait": "Auf Zurücksetzen warten",
  "limitSettings.action.switch": "Automatisch wechseln",
  "limitSettings.switchAtOption": "Bei {percent} % übrig",
  "limitSettings.waitOption.never": "Nie warten",
  "limitSettings.waitOption.hour": "Unter 1 Stunde",
  "limitSettings.waitOption.twoHours": "Unter 2 Stunden",
  "limitSettings.waitOption.minutes": "Unter {minutes} Min.",
  "limitSettings.action.title": "Wenn ein Anbieter erschöpft ist",
  "limitSettings.action.descriptionProject":
    "Was die Threads dieses Projekts tun, wenn ihr Anbieter ein Nutzungslimit erreicht. Beim Wechsel wird der Thread mit seinem Kontext im selben Worktree übergeben.",
  "limitSettings.action.description":
    "Was Threads tun, wenn ihr Anbieter ein Nutzungslimit erreicht. Projekte können das überschreiben.",
  "limitSettings.order.title": "Fallback-Reihenfolge",
  "limitSettings.order.description":
    "Die Modelle, auf denen ein limitierter Thread weitermacht, das beste zuerst. Das erste, das angemeldet ist und Luft hat, übernimmt den Thread; ein Thread, der schon darauf läuft, überspringt es, sodass Codex-Threads aus derselben Liste auf Claude ausweichen können.",
  "limitSettings.order.descriptionTiers":
    "Lass sie leer, um stattdessen deinen Modellstufen zu folgen; eine Liste hier ersetzt sie bei Limits.",
  "limitSettings.order.descriptionWaits": "Wenn keines davon Luft hat, wartet der Thread.",
  "limitSettings.order.descriptionAny":
    "Danach versucht SpecWithCode jeden anderen bereiten Anbieter.",
  "limitSettings.order.statusTiers": "Nutzt deine Modellstufen",
  "limitSettings.order.statusAny": "Jeder bereite Anbieter",
  "limitSettings.order.addModel": "Modell hinzufügen",
  "limitSettings.order.addAria": "Fallback-Modell hinzufügen",
  "limitSettings.order.noProviders": "Keine Anbieter verfügbar",
  "limitSettings.listOnly.title": "Nur diese Modelle",
  "limitSettings.listOnly.descriptionTiers":
    "Einen limitierten Thread nie auf einem Modell außerhalb deiner Modellstufen fortsetzen. Wenn keines davon Luft hat, wartet der Thread auf das Zurücksetzen.",
  "limitSettings.listOnly.descriptionOrder":
    "Einen limitierten Thread nie auf einem Modell außerhalb der Fallback-Reihenfolge fortsetzen. Wenn keines davon Luft hat, wartet der Thread auf das Zurücksetzen.",
  "limitSettings.options.title": "Wo ein limitierter Thread weitermachen kann",
  "limitSettings.options.description":
    "Die Modelle auf diesem Rechner, zu denen ein limitierter Thread wechseln kann, nach Familie zusammengefasst und nach Anbieter gruppiert, ältere Versionen eingeklappt. Schließe ein Modell aus, um es vom automatischen Fallback fernzuhalten; für das Minimum einer Familie schließe die Modelle darunter aus.",
  "limitSettings.options.none": "Nichts ausgeschlossen",
  "limitSettings.options.count": "{count} ausgeschlossen",
  "limitSettings.switchAt.title": "Vor dem Limit wechseln",
  "limitSettings.switchAt.description":
    "Mit „Automatisch wechseln“ startet der nächste Turn auf dem Fallback, sobald das knappste Nutzungsfenster des Anbieters nur noch so viel übrig hat. Mit „Fallback anbieten“ schlägt der Thread an diesem Punkt stattdessen den Wechsel vor. Nie mitten im Turn und nur zu einem Anbieter mit mehr Rest.",
  "limitSettings.switchAt.off": "Nur wenn er stoppt",
  "limitSettings.waitUnder.title": "Warten, wenn das Zurücksetzen nah ist",
  "limitSettings.waitUnder.description":
    "Wenn die Nutzung, die das Limit oder die Schwelle erreicht hat, innerhalb dieser Zeit zurückgesetzt wird, wird weder gewechselt noch eingelöst noch Geld ausgegeben: Der Thread wartet und macht beim Zurücksetzen auf demselben Anbieter weiter. Ist auch ein Wochenfenster ausgeschöpft, gilt das Warten nicht.",
  "limitSettings.subscription.title": "Automatisch mit einem neuen Abo weitermachen",
  "limitSettings.subscription.description":
    "Wenn ein Thread mit automatischem Weitermachen auf ein Limit wartet und seine CLI bei einem anderen Abo mit Luft angemeldet ist, macht der Thread dort ohne Nachfrage weiter. Wenn aus, oder bei ausgeschaltetem automatischem Weitermachen: Der Thread zeigt die Änderung und wartet auf deine Bestätigung. Anbieter und Modell bleiben gleich.",
  "limitSettings.redeem.title": "Zuerst einen gesparten Reset einlösen",
  "limitSettings.redeem.description":
    "Wenn ein Turn am Limit stoppt und ein frischer Nutzungswert bestätigt, dass das Konto am Limit ist, wird einer der gesparten Resets des Kontos eingelöst (Claude und Codex vergeben sie) und vor jedem Fallback auf demselben Anbieter weitergemacht. Höchstens einer pro Limitfenster, nie während Limits simuliert werden.",
  "limitSettings.spend.title": "Zuerst Codex-Guthaben verwenden",
  "limitSettings.spend.description":
    "Wenn ein Codex-Turn am Tariflimit stoppt und das Konto bezahltes Guthaben hat, wird dieser Turn vor jedem Fallback mit Guthaben fortgesetzt. SpecWithCode kauft nie Guthaben und ändert nie das automatische Aufladen.",
  "limitSettings.api.title": "Zuerst API-Guthaben verwenden",
  "limitSettings.api.description":
    "Wenn ein Turn mit Claude-Abo am Limit stoppt und ein neuer Nutzungswert das bestätigt, wird dieser Turn vor jedem Fallback mit demselben Modell auf einer Claude-Instanz fortgesetzt, die über Anthropic-API-Guthaben abrechnet (eigener API-Schlüssel oder Anmeldung über die Claude Console). Bei mehreren API-Konten wechselt ein Turn, den eines mangels Guthaben ablehnt, zum nächsten. Der Thread kehrt zum Abo zurück, wenn das Limit zurückgesetzt wird oder sobald das ausgeschaltet wird. Nie während Limits simuliert werden. Ohne diese Option bietet das Limit-Banner trotzdem jedes Konto als Schaltfläche an.",
  "limitSettings.api.statusNext": "Weiter auf {name}, dann auf dem nächsten von {count} API-Konten",
  "limitSettings.api.statusOne": "Weiter auf {name}, wenn es das Modell des Threads anbietet",
  "limitSettings.api.statusNotReady": "{name} ist nicht bereit, daher wird nichts verschoben",
  "limitSettings.api.statusNeeds":
    "Benötigt ein Claude-API-Konto: füge eines mit seinem Schlüssel hinzu",
  "limitSettings.api.addKey": "API-Schlüssel hinzufügen",
  "limitSettings.api.addAnother": "Weiteren hinzufügen",
  "limitSettings.redeem.confirmTitle": "Gesparte Resets automatisch einlösen?",
  "limitSettings.redeem.confirmProject":
    "Turns in diesem Projekt, die an einem bestätigten Nutzungslimit stoppen, lösen ohne Nachfrage einen der gesparten Resets des Kontos ein, höchstens einen pro Limitfenster. Ein eingelöster Reset ist weg.",
  "limitSettings.redeem.confirmGlobal":
    "Turns, die an einem bestätigten Nutzungslimit stoppen, lösen ohne Nachfrage einen der gesparten Resets des Kontos ein, höchstens einen pro Limitfenster, in jedem Projekt, das das nicht überschreibt. Ein eingelöster Reset ist weg.",
  "limitSettings.redeem.confirm": "Resets einlösen",
  "limitSettings.spend.confirmTitle": "Bezahltes Codex-Guthaben automatisch verwenden?",
  "limitSettings.spend.confirmProject":
    "Turns in diesem Projekt, die am Codex-Tariflimit stoppen, machen ohne Nachfrage mit dem bezahlten Guthaben des Kontos weiter. Guthaben kostet Geld und wird nicht erstattet.",
  "limitSettings.spend.confirmGlobal":
    "Turns, die am Codex-Tariflimit stoppen, machen ohne Nachfrage mit dem bezahlten Guthaben des Kontos weiter, in jedem Projekt, das das nicht überschreibt. Guthaben kostet Geld und wird nicht erstattet.",
  "limitSettings.spend.confirm": "Guthaben verwenden",
  "limitSettings.api.confirmTitle": "Claude-API-Guthaben automatisch verwenden?",
  "limitSettings.api.confirmProject":
    "Turns in diesem Projekt, die an einem bestätigten Claude-Abo-Limit stoppen, machen ohne Nachfrage auf deiner Claude-Instanz mit API-Schlüssel weiter, wechseln zum nächsten API-Konto, wenn eines kein Guthaben mehr hat, und der Thread bleibt dort, bis das Limit zurückgesetzt wird. Jeder Turn dort und jeder Thread, der von dort startet, wird der API-Organisation des Schlüssels zu API-Preisen berechnet. SpecWithCode kann dieses Guthaben weder lesen noch begrenzen; lege in der Claude Console ein Ausgabenlimit fest.",
  "limitSettings.api.confirmGlobal":
    "Turns, die an einem bestätigten Claude-Abo-Limit stoppen, machen ohne Nachfrage auf deiner Claude-Instanz mit API-Schlüssel weiter, wechseln zum nächsten API-Konto, wenn eines kein Guthaben mehr hat, in jedem Projekt, das das nicht überschreibt, und der Thread bleibt dort, bis das Limit zurückgesetzt wird. Jeder Turn dort und jeder Thread, der von dort startet, wird der API-Organisation des Schlüssels zu API-Preisen berechnet. SpecWithCode kann dieses Guthaben weder lesen noch begrenzen; lege in der Claude Console ein Ausgabenlimit fest.",
  "limitSettings.api.confirm": "API-Guthaben verwenden",
  "providerModels.count": { one: "{count} Modell", other: "{count} Modelle" },
  "providerModels.favorites": { one: "{count} Favorit", other: "{count} Favoriten" },
  "providerModels.hidden": { one: "{count} ausgeblendet", other: "{count} ausgeblendet" },
};
