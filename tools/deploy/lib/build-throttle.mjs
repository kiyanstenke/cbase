// An image build on the shared host must not starve the running installations: every `docker build` of the deploy runs under
// `nice -n 10 ionice -c3` (lowest CPU weight, idle I/O class). One place for the prefix, so the backend build, the project box
// build and the rollback rebuild cannot drift apart. Guard: tools/deploy/build-throttle.test.mjs.
export const BUILD_THROTTLE = "nice -n 10 ionice -c3";

/** Pure: puts the throttle in front of the `docker build` of a command line (a `cd … && docker build …` string). Throws if there is none. */
export function throttleBuild(command) {
  if (!/(^|&& |; )docker build /.test(command)) throw new TypeError(`throttleBuild: no docker build in: ${command}`);
  return command.replace(/(^|&& |; )docker build /, `$1${BUILD_THROTTLE} docker build `);
}
