export interface Model {
  id: string
  name: string
  desc: string
  tag?: string
}

export const MODELS: Model[] = [
  { id: 'vajb-agent-lite',      name: 'Lite',      desc: 'Brz i jeftin, za svakodnevne zadatke' },
  { id: 'vajb-agent-turbo',     name: 'Turbo',     desc: 'Brz, disciplinovan, završava sajtove za 2-3 min', tag: 'Preporučeno' },
  { id: 'vajb-agent-pro',       name: 'Pro',       desc: 'Ozbiljniji projekti, jak i pametan' },
  { id: 'vajb-agent-max',       name: 'Max',       desc: 'Kompleksniji zadaci i veća logika' },
  { id: 'vajb-agent-power',     name: 'Power',     desc: 'Premium — velika logika i brzina' },
  { id: 'vajb-agent-ultra',     name: 'Ultra',     desc: 'Premium — dug coding i detaljna izrada' },
  { id: 'vajb-agent-architect', name: 'Architect', desc: 'Premium — full-stack arhitektura i planiranje' },
]

export const DEFAULT_MODEL = 'vajb-agent-turbo'
