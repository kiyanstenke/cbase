// The fake CLIs' ripcord - ONE concept, ONE number, ONE place.
//
// WHY. A fake that outlives its test keeps the TEST PROCESS alive through its open stdout pipe; `node --test` then
// never ends the file, and a failure turns into a hang without a single red line. So every fake carries a ripcord:
// at some point it exits by itself, whatever the server does.
//
// WHY ONE NUMBER. Many ripcords with different guessed numbers were each a disguised DEADLINE: under high test
// concurrency a perfectly normal fake run outlives a small one, the fake dies with code 9, and the test reports a
// functional failure where only the machine was slow. A ripcord is not a deadline. It has exactly one job, so
// exactly one number.
//
// WHY 120 000. The number must sit so far above any plausible run that load never reaches it, and so far below the
// suites' stall limit (`CBASE_SUITE_STALL_MS`, default 180 000 without a test result) that a really hanging
// fake still dies first and the test says why. It is three times the longest test of this family (a limit-reset
// wait of about 43 s).
//
// WHY `unref()`. The ripcord must not keep the fake alive artificially. Without `unref` a fake that had done its
// work ran on until the number expired and then died with code 9 instead of 0. `unref` removes the timer from the
// event-loop accounting: it fires only while something else keeps the fake open (stdin, readline) - exactly in the
// hang case.
//
// USAGE. The fakes are template strings that become standalone Node scripts; they cannot import anything. So the
// line is inserted, not called:
//
//     const fakeClaude = `#!/usr/bin/env node
//     ${RIPCORD}
//     ...`;
//
// Where the fake ends properly it may call `clearTimeout(guard)` - the name `guard` is part of the concept and
// therefore stands here, not in every file.
//
// Guard: `server/backend/test/clock-counts.test.js` (a ripcord with its own number is red).
export const RIPCORD_MS = 120_000;
export const RIPCORD = `const guard = setTimeout(() => process.exit(9), ${RIPCORD_MS}).unref();`;
