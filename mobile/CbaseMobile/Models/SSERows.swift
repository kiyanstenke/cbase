import Foundation

// The rows of an SSE stream: split ONLY at LF, CR and CRLF, like the SSE specification and the browser.
//
// `URLSession.AsyncBytes.lines` (`AsyncLineSequence`) also splits at U+2028, U+2029, U+0085, VT and FF and drops empty
// lines. JSON always escapes VT and FF, but `JSON.stringify` leaves the other three raw, so an event whose text carried one
// (chat text from the network, terminal output) tore into two rows: `namedStream` dropped it silently and `stream` ended the
// WHOLE stream with a decode error. This separator works on bytes instead: CR and LF never occur inside another character in
// UTF-8, so splitting at byte level cuts nothing. Empty lines are kept (they mark the end of an event; both readers reset the
// event name there, as the specification requires). A partial row at the end of the stream is dropped (the specification
// discards an incomplete event; half a JSON would otherwise have aborted `stream`).
// `SSELineSeparator` is pure and dependency-free; `web/test/sse-rows-ios.test.mjs` runs it with `xcrun swift`.

/// The separator's state: bytes go in one by one, a finished row (without separator) comes out.
struct SSELineSeparator {
    private var row: [UInt8] = []
    private var afterCR = false

    /// Feed one byte; returns the row it ends, otherwise nil. CRLF ends ONE row.
    mutating func take(_ byte: UInt8) -> String? {
        if afterCR {
            afterCR = false
            if byte == 0x0A { return nil }
        }
        switch byte {
        case 0x0A:
            return close()
        case 0x0D:
            afterCR = true
            return close()
        default:
            row.append(byte)
            return nil
        }
    }

    private mutating func close() -> String {
        defer { row.removeAll(keepingCapacity: true) }
        return String(decoding: row, as: UTF8.self)
    }
}

/// The rows of a byte sequence according to `SSELineSeparator`.
struct SSERows<Base: AsyncSequence>: AsyncSequence where Base.Element == UInt8 {
    typealias Element = String
    let base: Base

    struct AsyncIterator: AsyncIteratorProtocol {
        var inner: Base.AsyncIterator
        var separator = SSELineSeparator()

        mutating func next() async throws -> String? {
            while let byte = try await inner.next() {
                if let row = separator.take(byte) { return row }
            }
            return nil
        }
    }

    func makeAsyncIterator() -> AsyncIterator { AsyncIterator(inner: base.makeAsyncIterator()) }
}

extension AsyncSequence where Element == UInt8 {
    /// The rows of an SSE stream, instead of `.lines` (see the file header).
    var sseLines: SSERows<Self> { SSERows(base: self) }
}
