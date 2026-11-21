export const meta = {
  name: 'journal-fixture',
  description: 'Harmloser Workflow mit Fixture-Prompts: erzeugt das Journal-Fixture der Schlüsselkette (cbase, Ticket 62; seit 2.1.322 mit Zweigen)',
  phases: [{ title: 'Eins' }, { title: 'Zwei' }, { title: 'Drei' }],
}
phase('Eins')
const a = await agent('Fixture-Prompt 1: antworte genau mit ALPHA.', { label: 'eins' })
const [b, c] = await parallel([
  () => agent('Fixture-Prompt 2: antworte genau mit BETA — Umlaute: äöü ß.', { label: 'zwei', effort: 'low', agentType: 'general-purpose' }),
  () => agent('Fixture-Prompt 3: gib das Objekt { wort: GAMMA, zahl: 3 } zurück.', {
    label: 'drei',
    phase: 'Zwei',
    schema: { type: 'object', required: ['wort', 'zahl'], properties: { zahl: { type: 'number' }, wort: { type: 'string' } } },
  }),
])
phase('Zwei')
// Nach dem parallel(): dieser Aufruf hängt am join.
const d = await agent(`Fixture-Prompt 4: verbinde ${a} und ${b}.`, { model: 'haiku', label: 'vier' })
const e = await agent('Fixture-Prompt 5: dieser Aufruf scheitert an der Attrappe (im ersten Durchgang).', { label: 'fuenf' })
phase('Drei')
// Ein Zweig mit ZWEI Agenten nacheinander; daneben ein verschachteltes parallel() mit einem Agenten hinter dessen join.
const [f, g] = await parallel([
  async () => {
    const x = await agent('Fixture-Prompt 6: antworte genau mit DELTA.', { label: 'sechs' })
    return agent(`Fixture-Prompt 7: antworte genau mit EPSILON (nach ${x}).`, { label: 'sieben' })
  },
  async () => {
    const [p, q] = await parallel([
      () => agent('Fixture-Prompt 8: antworte genau mit ZETA.', { label: 'acht' }),
      () => agent('Fixture-Prompt 9: antworte genau mit ETA.', { label: 'neun', disallowedTools: ['Write', 'Edit', 'Write'], bashCommandClamp: ['Bash(ls)', 'Bash(echo hi)'] }),
    ])
    return agent(`Fixture-Prompt 10: antworte genau mit THETA (nach ${p} und ${q}).`, { label: 'zehn' })
  },
])
// pipeline() mit zwei Stufen: ein Platz je Element über beide Stufen.
const h = await pipeline(
  ['X', 'Y'],
  (item) => agent(`Fixture-Prompt 11: antworte genau mit IOTA (Element ${item}).`, { label: `elf-${item}` }),
  (r, item) => agent(`Fixture-Prompt 12: antworte genau mit KAPPA (Element ${item} nach ${r}).`, { label: `zwoelf-${item}` }),
)
// Ein NICHT abgewartetes parallel(), dahinter ein agent() in derselben Bahn: die Gabel steht beim Aufruf, der join rechnet auf
// dem Stand, den die Bahn dann hat.
const offen = parallel([() => agent('Fixture-Prompt 13: antworte genau mit LAMBDA.', { label: 'dreizehn' })])
const i = await agent('Fixture-Prompt 14: antworte genau mit MY.', { label: 'vierzehn' })
const [j] = await offen
const k = await agent(`Fixture-Prompt 15: antworte genau mit NY (nach ${i} und ${j}).`, { label: 'fuenfzehn' })
return { a, b, c, d, e, f, g, h, i, j, k }
