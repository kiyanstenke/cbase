export const meta = {
  name: 'journal-fixture',
  description: 'Harmloser Workflow mit Fixture-Prompts: erzeugt das Journal-Fixture der Schlüsselkette (cbase, Ticket 62)',
  phases: [{ title: 'Eins' }, { title: 'Zwei' }],
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
const d = await agent(`Fixture-Prompt 4: verbinde ${a} und ${b}.`, { model: 'haiku', label: 'vier' })
const e = await agent('Fixture-Prompt 5: dieser Aufruf scheitert an der Attrappe.', { label: 'fuenf' })
return { a, b, c, d, e }
