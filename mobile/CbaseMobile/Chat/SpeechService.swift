import AVFoundation
import Foundation

/// Reading a message aloud (the "Read aloud" button under every bubble).
///
/// Two voices, one control: if the settings hold an ElevenLabs key, `POST /api/tts` delivers the finished MP3 (the server
/// tones Markdown down to speech text and keeps the result in its cache). Without a key the route answers 409; then
/// `AVSpeechSynthesizer` takes over. So the button works without any setup.
///
/// Only ONE message speaks at a time: a second press on the same one stops it, a press on another takes over.
@MainActor
final class SpeechService: ObservableObject {
    static let shared = SpeechService()

    /// Key of the message currently being spoken (chat id + position).
    @Published private(set) var speakingKey: String?
    /// Is the voice currently being fetched from the server?
    @Published private(set) var loadingKey: String?

    private var player: AVAudioPlayer?
    private let synthesizer = AVSpeechSynthesizer()
    private let bridge = PlaybackBridge()

    private init() {
        bridge.onDone = { [weak self] in
            Task { @MainActor in self?.finish() }
        }
        synthesizer.delegate = bridge
    }

    func toggle(key: String, text: String, client: APIClient) async {
        if speakingKey == key || loadingKey == key {
            stop()
            return
        }
        stop()
        let spoken = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return }

        loadingKey = key
        var audio: Data?
        do {
            audio = try await client.send("/api/tts", body: TtsRequest(text: spoken))
        } catch let error as APIError where error.status == 409 {
            audio = nil // No key: the planned route to the system voice.
        } catch {
            audio = nil
            print("[tts] Server voice not available: \(error.localizedDescription)")
        }
        loadingKey = nil
        // Cancelled in the meantime (another button pressed)?
        guard speakingKey == nil else { return }

        if let audio, !audio.isEmpty, playRemote(audio, key: key) { return }
        speakWithSystemVoice(spoken, key: key)
    }

    func stop() {
        player?.stop()
        player = nil
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        speakingKey = nil
        loadingKey = nil
    }

    // ── Routes ───────────────────────────────────────────────────────────────

    private func playRemote(_ data: Data, key: String) -> Bool {
        prepareSession()
        do {
            let player = try AVAudioPlayer(data: data)
            player.delegate = bridge
            self.player = player
            guard player.play() else { return false }
            speakingKey = key
            return true
        } catch {
            print("[tts] MP3 could not be played: \(error.localizedDescription)")
            return false
        }
    }

    private func speakWithSystemVoice(_ text: String, key: String) {
        prepareSession()
        let utterance = AVSpeechUtterance(string: text)
        // Language of the interface (Loc carries the user's choice).
        utterance.voice = AVSpeechSynthesisVoice(language: Loc.lang == .en ? "en-US" : "de-DE")
        speakingKey = key
        synthesizer.speak(utterance)
    }

    /// Reading aloud should be audible even with the ringer switch off, like any other speech output. Set the category
    /// only here so video and recording in the chat stay untouched as long as nobody has anything read aloud.
    private func prepareSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio)
        try? session.setActive(true)
    }

    private func finish() {
        player = nil
        speakingKey = nil
        loadingKey = nil
    }
}

private struct TtsRequest: Encodable {
    let text: String
}

/// Bridge for the delegate callbacks of AVAudioPlayer and AVSpeechSynthesizer (both are `NSObject` protocols and do not
/// fit directly on a `@MainActor` class).
private final class PlaybackBridge: NSObject, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    var onDone: (() -> Void)?

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { onDone?() }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) { onDone?() }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { onDone?() }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { onDone?() }
}
