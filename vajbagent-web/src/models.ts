export interface Model {
  id: string
  name: string
  desc: string
  tag?: string
}

export const MODELS: Model[] = [
  { id: 'vajb-agent-lite',      name: 'Lite',      desc: 'Brz i jeftin, za svakodnevne zadatke' },
  { id: 'vajb-agent-turbo',     name: 'Turbo',     desc: 'Brz, jeftin, precizan — jak tool-caller' },
  { id: 'vajb-agent-pro',       name: 'Pro',       desc: 'Ozbiljniji projekti, jak i pametan' },
  { id: 'vajb-agent-max',       name: 'Max',       desc: 'Najbolji balans cene i kvaliteta za sajtove', tag: 'Preporučeno' },
  { id: 'vajb-agent-power',     name: 'Power',     desc: 'Najjači OpenAI — flagship GPT-5.4' },
  { id: 'vajb-agent-ultra',     name: 'Ultra',     desc: 'Opus 4.7 — najjači Anthropic, long-running coding', tag: 'Najjači' },
  { id: 'vajb-agent-architect', name: 'Architect', desc: 'Opus 4.7 za full-stack arhitekturu i planiranje' },
]

export const DEFAULT_MODEL = 'vajb-agent-max'
