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
  { id: 'vajb-agent-power',     name: 'Power',     desc: 'Najjači za zahtevne projekte' },
  { id: 'vajb-agent-ultra',     name: 'Ultra',     desc: 'Premium kvalitet, vrhunska preciznost', tag: 'Najjači' },
  { id: 'vajb-agent-architect', name: 'Architect', desc: 'Za složenije frontend projekte i planiranje strukture' },
]

export const DEFAULT_MODEL = 'vajb-agent-max'
