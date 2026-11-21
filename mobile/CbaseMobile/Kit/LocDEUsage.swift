import Foundation

// German translations: providers and usage.
let LocDEUsage: [String: String] = [
    // Subpages and list
    "At the limit": "Am Limit",
    "Quotas, API value and costs at a glance": "Kontingente, Gegenwert und Kosten auf einen Blick",
    "Subscription: windows, limits, API value, where it goes": "Abo: Fenster, Limits, Gegenwert, wohin es geht",
    "Subscription: windows, API value, where it goes": "Abo: Fenster, Gegenwert, wohin es geht",
    "Credits and costs per model and chat": "Guthaben und Kosten je Modell und Chat",
    "Continuing at the limit, credit gate, what is waiting": "Weitermachen am Limit, Guthaben-Gate, wer wartet",
    "Quotas, API value and OpenRouter costs": "Kontingente, Gegenwert und OpenRouter-Kosten",
    "Sign in to and switch between Claude, Codex and OpenRouter": "Claude, Codex und OpenRouter anmelden und wechseln",
    "Cap and size guideline of dynamic workflows": "Deckel und Größenleitlinie der dynamischen Workflows",
    "Opens the usage of {name}": "Öffnet die Nutzung von {name}",

    // Windows
    "Current window": "Aktuelles Fenster",
    "Current week": "Aktuelle Woche",
    "30 days": "30 Tage",
    "All time": "Gesamt",
    "Last 5 hrs": "Letzte 5 Std.",
    "Last 7 days": "Letzte 7 Tage",
    "Rolling — no snapshot of the provider's window yet.": "Gleitend gerechnet — vom Fenster des Anbieters liegt noch kein Stand vor.",

    // Equivalent and tokens
    "API equivalent": "API-Gegenwert",
    "Estimate at API list price — the subscription counts its quota itself.": "Schätzung nach API-Listenpreis — das Abo rechnet sein Kontingent selbst.",
    "No price is known for the models in this window.": "Für die Modelle dieses Fensters ist kein Preis bekannt.",
    "Lower bound — not everything has a known price.": "Untergrenze — nicht für alles ist ein Preis bekannt.",
    "Cache read": "Cache lesen",
    "Cache write": "Cache schreiben",
    "Cache, not split": "Cache, nicht aufgeteilt",
    "Nothing was recorded in this time window.": "In diesem Zeitfenster wurde nichts erfasst.",
    "By model": "Je Modell",
    "Price unknown": "Preis unbekannt",
    "and 1 more chat": "und 1 weiterer Chat",
    "and {n} more chats": "und {n} weitere Chats",
    "History — {n} days": "Verlauf — {n} Tage",
    "Output tokens per day": "Output-Tokens je Tag",
    "Output tokens per day — the amount is missing on one day.": "Output-Tokens je Tag — an einem Tag fehlt der Betrag.",
    "Output tokens per day — the amount is missing on {n} days.": "Output-Tokens je Tag — an {n} Tagen fehlt der Betrag.",
    "Nothing was recorded on these days.": "In diesen Tagen wurde nichts erfasst.",
    "Highest day {day}: {value}": "Höchster Tag {day}: {value}",

    // Claude: limits
    "Limits": "Limits",
    "Never measured.": "Noch nie gemessen.",
    "measured just now": "gemessen gerade eben",
    "measured {n} min ago": "gemessen vor {n} Min.",

    // OpenRouter: credit and costs
    "Deposited": "Eingezahlt",
    "Spent": "Verbraucht",
    "Key limit": "Deckel des Schlüssels",
    "{rest} of {limit} left": "{rest} von {limit} übrig",
    "Credits are not available right now — no key stored or OpenRouter is not responding.": "Das Guthaben ist gerade nicht abrufbar — kein Schlüssel hinterlegt oder OpenRouter antwortet nicht.",
    "As of {time}": "Stand {time}",
    "Nothing was billed through OpenRouter in this window.": "In diesem Zeitfenster wurde nichts über OpenRouter abgerechnet.",
    "{origin}: {n}": "{origin}: {n}",
    "Lower bound — {n} runs without an amount.": "Untergrenze — {n} Läufe ohne Betrag.",
    "queried": "nachgefragt",
    "estimated": "geschätzt",

    // Overview
    "{amount} API value in 30 days": "{amount} Gegenwert in 30 Tagen",
    "{amount} costs in 30 days": "{amount} Kosten in 30 Tagen",
    "Nothing is waiting for a reset": "Nichts wartet auf einen Reset",
    "1 run is waiting for a reset": "1 Lauf wartet auf einen Reset",
    "{n} runs are waiting for a reset": "{n} Läufe warten auf einen Reset",

    // Roles of the background tasks (contract ONCE_ROLES)
    "Classification": "Einordnung",
    "Second look": "Zweiter Blick",
    "Compaction": "Verdichtung",
    "Chat title": "Chat-Titel",
    "Workflow verdict": "Workflow-Urteil",
    "Classify context": "Kontext einordnen",
    "Classify project": "Projekt einordnen",
    "Merge project context": "Projektkontext zusammenführen",
    "Assign project": "Projekt zuordnen",
    "Curate context": "Kontext pflegen",
    "Detect services": "Dienste erkennen",

    // OpenRouter card
    "API key (sk-or-…)": "API-Schlüssel (sk-or-…)",
    "Enter a new key": "Neuen Schlüssel eintragen",
    "Only providers without data retention": "Nur Anbieter ohne Datenspeicherung",
    "OpenRouter only routes to providers that do not store requests (zero data retention).": "OpenRouter leitet nur an Anbieter weiter, die Anfragen nicht speichern (Zero Data Retention).",
    "No data use by providers": "Keine Datennutzung durch Anbieter",
    "Providers that use requests for training or otherwise are skipped.": "Anbieter, die Anfragen zum Training oder anderweitig nutzen, werden übersprungen.",

    // Model choice with search
    "Search models": "Modell suchen",
    "No model matches “{search}”.": "Kein Modell passt zu „{search}“.",
    "Choose from the catalog": "Aus dem Katalog wählen",
    "{n} models — search in the chat settings or /model <name>": "{n} Modelle — Suche in den Chat-Einstellungen oder /model <Name>",
]
