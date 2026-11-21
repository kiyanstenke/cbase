// Preload of every gate suite (`--import` in NODE_TEST, tools/check/targets/check.mjs): inside a `node --test` CHILD, plain text on
// stdout goes to stderr; only the framed messages of the runner protocol stay on stdout.
//
// Why: a test file's child speaks the v8 protocol to the runner on stdout (each message: v8 header FF 0F, a 4-byte big-endian size,
// the serialised item). Text written to stdout by the code under test (console.log of tools/check/lib/log.mjs, for one) shares that
// pipe. Node 22's parser (lib/internal/test_runner/runner.js, FileTest #processRawBuffer) reads text that arrives in the SAME read
// right after a complete message as if it were the next frame: it takes bytes 2..5 of the text as the size, and with `<< 24` a third
// byte >= 0x80 makes that size negative — the "complete" frame is handed to the deserialiser and the file fails with
// "Unable to deserialize cloned data due to invalid or unsupported version." (failureType uncaughtException). Log lines like
// "\n▸ step" (0A E2 96 ..) or "  ✓ done" (20 20 E2 ..) hit exactly that. A message and the text land in one read only when the runner
// reads slower than the child writes — under load — which is why it struck tools/deploy/init.test.mjs in two full gates and never alone.
//
// stderr is not parsed by the runner (it is read line by line and reported as test:stderr), so the text still shows up in the TAP
// output as a `#` comment; nothing is silenced.
//
// Only in the runner's own child: `NODE_TEST_CONTEXT=child-v8` without an IPC channel. The gate deletes NODE_TEST_CONTEXT for the
// runner itself; a process a test forks inherits the variable but has `process.send`. A process a test spawns does not carry this
// `--import` (it is passed on through the runner's execArgv, not the environment).
//
// Guard: tools/check/test-stdout-guard.test.mjs (counter-proof without the preload, the same run with it).

const V8_HEADER_0 = 0xff;
const V8_HEADER_1 = 0x0f;

export function isProtocolFrame(chunk) {
  return chunk instanceof Uint8Array && chunk.length >= 2 && chunk[0] === V8_HEADER_0 && chunk[1] === V8_HEADER_1;
}

if (process.env.NODE_TEST_CONTEXT === "child-v8" && typeof process.send !== "function") {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = function guardedWrite(chunk, ...rest) {
    return isProtocolFrame(chunk) ? stdoutWrite(chunk, ...rest) : stderrWrite(chunk, ...rest);
  };
}
