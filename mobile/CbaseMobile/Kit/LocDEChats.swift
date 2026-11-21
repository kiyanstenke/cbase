import Foundation

// German translations: chat settings, archive view, composer strip and slash answers.
let LocDEChats: [String: String] = [
    // Settings → Chats
    "Archive old chats automatically": "Alte Chats automatisch archivieren",
    "Archive chats automatically": "Chats automatisch archivieren",
    "Pinned chats and chats with open work stay. Nothing is deleted.": "Angeheftete Chats und Chats mit offener Arbeit bleiben. Nichts wird gelöscht.",
    "After days without a new message": "Nach Tagen ohne neue Nachricht",
    "Every message resets the clock — including one from an agent, a channel or a scheduled task. 1 to 365 days are allowed.": "Jede Nachricht setzt die Uhr zurück — auch die eines Agenten, eines Kanals oder eines geplanten Auftrags. Erlaubt sind 1 bis 365 Tage.",
    "Days without a new message": "Tage ohne neue Nachricht",
    "Please enter a whole number from 1 to 365.": "Bitte eine ganze Zahl von 1 bis 365.",
    // Archive view
    "archived automatically": "automatisch archiviert",
    // Composer strip: compacting and goal
    "Compacting the context…": "Kontext wird komprimiert…",
    "Messages are queued and start right after.": "Nachrichten werden eingereiht und laufen danach los.",
    "Pursuing goal": "Ziel wird verfolgt",
    "Goal paused": "Ziel pausiert",
    "Delete goal": "Ziel löschen",
    "Pause goal": "Ziel pausieren",
    "Resume goal": "Ziel fortsetzen",
    "Expand goal": "Ziel aufklappen",
    "Collapse goal": "Ziel zuklappen",
    // Paused goal
    "The goal is paused: the harness does not check it until you resume it from the goal row above the input field. Saving a changed text resumes it as well.": "Das Ziel ist pausiert: der Harness prüft es nicht, bis du es an der Ziel-Zeile über dem Eingabefeld fortsetzt. Speichern mit geändertem Text setzt es ebenfalls fort.",
    "Paused — it is not pursued until you resume it from the goal row.": "Pausiert — es wird nicht verfolgt, bis du es an der Ziel-Zeile fortsetzt.",
    // Save artifacts and folder context
    "Save changes?": "Änderungen speichern?",
    "\"{name}\" has unsaved changes.": "„{name}“ hat ungespeicherte Änderungen.",
    "saved": "gespeichert",
    "The file has changed elsewhere in the meantime. Saving will fail — copy your text and open the file again.": "Die Datei wurde inzwischen woanders geändert. Speichern schlägt fehl — sichere deinen Text und öffne sie neu.",
    // Images from the clipboard
    "Could not read the image from the clipboard.": "Bild aus der Zwischenablage konnte nicht gelesen werden.",
    // Slash command answers
    "Goal cleared.": "Ziel entfernt.",
    "No goal set.": "Kein Ziel gesetzt.",
    "Available: full, auto, plan, ask.": "Verfügbar: voll, auto, plan, fragen.",
    "Current: **{model}**\n\nAvailable:\n{list}": "Aktuell: **{model}**\n\nVerfügbar:\n{list}",
    "Unknown: \"{arg}\". Use /model for the list.": "Unbekannt: „{arg}“. Nutze /model für die Liste.",
    "Replies: {n}\n\nContext now: {used} / {window} ({percent} %)\n\nOutput total: ~{output} tokens\n\nRuntime total: {time}": "Antworten: {n}\n\nKontext aktuell: {used} / {window} ({percent} %)\n\nAusgabe gesamt: ~{output} Tokens\n\nLaufzeit gesamt: {time}",
    "_Runs via your Claude subscription._": "_Läuft über dein Claude-Abo._",
    // Stream
    "Unknown error": "Unbekannter Fehler",
]
