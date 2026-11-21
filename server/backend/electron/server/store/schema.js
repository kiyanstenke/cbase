// The schema registry of the data layer. A LEAF with ZERO imports — and that is its reason: `db.js` and the topic
// files need a place to meet without one pulling the other back in. If the registry lived in `db.js`, or loaded the
// topic files itself, the cycle over all store/ files would be back at once. Registration therefore happens in the
// facade `store.js`, which every initStore caller passes anyway; here is only the mechanism.
//
// A registration is ATOMIC: what MUST run together belongs in ONE. The registry knows no dependencies, only order —
// the registration order IS the call order.

const schemata = [];   // // [name, fn] in registration order

export function registerSchema(name, fn) {
  if (typeof name !== "string" || !name) throw new Error("registerSchema: name must be a string literal");
  if (typeof fn !== "function") throw new Error(`registerSchema(${name}): not a function`);
  if (schemata.some(([n]) => n === name)) throw new Error(`registerSchema: "${name}" is already registered`);
  schemata.push([name, fn]);
}

export function runSchemata() {
  if (!schemata.length) throw new Error("the schema registry is EMPTY — initStore was called past the facade store.js; the tables of the topic files would silently not be created");
  for (const [, fn] of schemata) fn();
}

export function schemaNames() { return schemata.map(([n]) => n); }
