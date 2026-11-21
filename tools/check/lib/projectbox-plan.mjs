// The pure parts of the project box distribution: the probe pool and label, and the address ranges the pool must not touch. No
// deploy configuration, no ssh — importable by product tests. The scripts that use them are in ./projectbox-distribution.mjs
// (which re-exports these names).

export const PROBE_POOL = "10.249.0.0/16";
export const PROBE_LABEL = "cbase.probe=1";

// Address ranges the probe pool must not touch (guard in the test).
export const OCCUPIED_RANGES = [
  { cidr: "10.230.0.0/16", what: "level 2: the project networks cbase-pn-* in B (selectSubnet)" },
  { cidr: "10.241.0.0/16", what: "inner pool of every project container (creationArgs)" },
  { cidr: "172.24.0.0/16", what: "eth0 of B (network of the user containers)" },
  { cidr: "172.16.0.0/12", what: "default pools of B's daemon (172.17–172.31/16): docker0, networks of unconverted stacks" },
  { cidr: "192.168.0.0/16", what: "default pool of B's daemon (192.168.0.0/16 in /20)" },
];

function cidrSpan(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(String(s));
  if (!m || m.slice(1, 5).some((x) => Number(x) > 255) || Number(m[5]) > 32) throw new TypeError(`not an IPv4 CIDR: ${s}`);
  const base = ((Number(m[1]) << 24) >>> 0) + (Number(m[2]) << 16) + (Number(m[3]) << 8) + Number(m[4]);
  const size = 2 ** (32 - Number(m[5]));
  const start = base - (base % size);
  return { start, end: start + size - 1 };
}
export function rangesIntersect(a, b) {
  const x = cidrSpan(a);
  const y = cidrSpan(b);
  return x.start <= y.end && y.start <= x.end;
}
