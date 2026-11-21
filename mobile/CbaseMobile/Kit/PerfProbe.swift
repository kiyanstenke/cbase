import Foundation
import QuartzCore

#if DEBUG
/// Aggregating runtime probe for the chat history — active only in DEBUG and only with CBASE_PERF_PROBE set (file path, or `TMP`
/// for the container tmp).
///
/// Unlike the existing traces (`ChatEntranceTrace`, `KeyboardTrace`) it does NOT write a line per frame: the question here is not
/// the course of a motion but WHERE the time goes. So per mark only count, sum and maximum — and beside it the frame gaps, split
/// into "marker session running" and "normal scrolling". Only both together answer the question: a jank is a long frame gap, and
/// the marks say which work was in it.
///
/// Writing itself must not distort the measurement — so the table goes out only every second, not per mark.
@MainActor
final class PerfProbe {
    static let shared = PerfProbe()

    private static let path: String? = {
        guard let raw = ProcessInfo.processInfo.environment["CBASE_PERF_PROBE"],
              !raw.isEmpty else { return nil }
        if raw.hasPrefix("/") { return raw }
        return NSTemporaryDirectory() + (raw == "TMP" ? "cbase-perf-probe.log" : raw)
    }()

    /// Cached as `static let`: the lookup sits in paths that run per frame.
    static let isOn = path != nil

    /// Seconds after start at which the store is cleared ONCE (CBASE_PERF_PROBE_RESET). Without this cut the chat's initial build
    /// sits in the same numbers as scrolling — and since it is the most expensive single moment of the whole session, every maximum
    /// would be its, not scrolling's.
    private static let resetAfter: Double? = ProcessInfo.processInfo
        .environment["CBASE_PERF_PROBE_RESET"].flatMap(Double.init)

    private struct Tally {
        var count = 0
        var total: Double = 0
        var maximum: Double = 0
    }

    /// Frame gaps of a phase. Buckets instead of all values — it is about the distribution, and the probe must not eat memory when
    /// it runs along for minutes.
    private struct Frames {
        var count = 0
        var total: Double = 0
        var maximum: Double = 0
        /// ≤ 9 ms (120 Hz), ≤ 17 ms (60 Hz), ≤ 34 ms, ≤ 67 ms, above.
        var buckets = [Int](repeating: 0, count: 5)

        mutating func add(_ dt: Double) {
            count += 1
            total += dt
            maximum = max(maximum, dt)
            let ms = dt * 1000
            let index = ms <= 9 ? 0 : ms <= 17 ? 1 : ms <= 34 ? 2 : ms <= 67 ? 3 : 4
            buckets[index] += 1
        }
    }

    private var tallies: [String: Tally] = [:]
    private var idle = Frames()
    private var marking = Frames()
    private var link: CADisplayLink?
    private var lastFrame: CFTimeInterval = 0
    private var lastFlush: CFTimeInterval = 0
    private var watchStart: CFTimeInterval = 0
    private var didReset = false
    /// Who decides whether the running phase is "marking". Set by the marker view, so the probe need not know anything about the chat.
    var isMarking: () -> Bool = { false }

    private init() {}

    /// Call once when the chat appears. From then on the frame watcher runs continuously — only so is a frame gap WITHOUT finger
    /// contact (inertial scrolling, loading more) visible at all.
    func startFrameWatch() {
        guard Self.isOn, link == nil else { return }
        lastFrame = CACurrentMediaTime()
        lastFlush = lastFrame
        watchStart = lastFrame
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick() {
        let now = CACurrentMediaTime()
        let dt = now - lastFrame
        lastFrame = now
        if let after = Self.resetAfter, !didReset, now - watchStart > after {
            didReset = true
            tallies = [:]
            idle = Frames()
            marking = Frames()
        }
        // The first gap after start is unusable (start somewhere in the frame).
        if dt > 0, dt < 2 {
            if isMarking() { marking.add(dt) } else { idle.add(dt) }
        }
        if now - lastFlush > 1 {
            lastFlush = now
            flush()
        }
    }

    func measure<T>(_ label: String, _ body: () throws -> T) rethrows -> T {
        guard Self.isOn else { return try body() }
        let start = CACurrentMediaTime()
        defer { add(label, CACurrentMediaTime() - start) }
        return try body()
    }

    func add(_ label: String, _ seconds: Double) {
        guard Self.isOn else { return }
        var tally = tallies[label] ?? Tally()
        tally.count += 1
        tally.total += seconds
        tally.maximum = max(tally.maximum, seconds)
        tallies[label] = tally
    }

    func count(_ label: String) {
        add(label, 0)
    }

    /// Human-readable table — deliberately no CSV: it is read directly, not processed further.
    var report: String {
        // No `%s` with `utf8String`: its pointer belongs to a temporary NSString and is already gone at formatting. So pad by hand.
        func pad(_ text: String, _ width: Int) -> String {
            text.count >= width ? text : text + String(repeating: " ", count: width - text.count)
        }
        var lines: [String] = []
        lines.append(pad("marker", 26) + "anzahl   sum_ms   medium_ms    max_ms")
        for (label, tally) in tallies.sorted(by: { $0.value.total > $1.value.total }) {
            lines.append(pad(label, 26) + String(
                format: "%6d %10.1f %11.3f %9.2f",
                tally.count,
                tally.total * 1000,
                tally.count > 0 ? tally.total * 1000 / Double(tally.count) : 0,
                tally.maximum * 1000
            ))
        }
        lines.append("")
        lines.append(pad("frame gaps", 26) + "frames  medium_ms    max_ms   <=9  <=17  <=34  <=67   >67")
        for (name, frames) in [("without marking", idle), ("marking active", marking)] {
            guard frames.count > 0 else { continue }
            lines.append(pad(name, 26) + String(
                format: "%6d %10.2f %9.2f %5d %5d %5d %5d %5d",
                frames.count,
                frames.total * 1000 / Double(frames.count), frames.maximum * 1000,
                frames.buckets[0], frames.buckets[1], frames.buckets[2],
                frames.buckets[3], frames.buckets[4]
            ))
        }
        return lines.joined(separator: "\n") + "\n"
    }

    func flush() {
        guard let path = Self.path else { return }
        try? report.write(toFile: path, atomically: true, encoding: .utf8)
    }
}
#endif
