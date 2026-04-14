/**
 * Filters files before pushing to GitHub / deploying.
 * SECURITY: strips .env, credential files, build artifacts.
 *
 * The backend also enforces this filter independently — never rely on
 * the frontend alone for secret protection.
 */

const SKIP_DIR_RE = /^(node_modules|\.git|dist|out|build|\.next|\.nuxt|\.cache|\.turbo|\.vercel|\.netlify|coverage|\.idea|\.vscode)\//
const SECRET_FILE_REGEXES: RegExp[] = [
  /^\.env(\..*)?$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^(service-account|firebase-credentials|credentials|secrets)(\..+)?\.json$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\..+)?$/,
]

export interface FilterResult {
  kept: Record<string, string>
  skipped: { path: string; reason: 'build' | 'secret' }[]
}

function isSecretFile(path: string): boolean {
  const base = path.split('/').pop() || path
  return SECRET_FILE_REGEXES.some(re => re.test(base))
}

export function filterForPush(files: Record<string, string>): FilterResult {
  const kept: Record<string, string> = {}
  const skipped: FilterResult['skipped'] = []
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith('/')) continue
    if (typeof content !== 'string') continue
    if (SKIP_DIR_RE.test(path)) {
      skipped.push({ path, reason: 'build' })
      continue
    }
    if (isSecretFile(path)) {
      skipped.push({ path, reason: 'secret' })
      continue
    }
    kept[path] = content
  }
  return { kept, skipped }
}

/**
 * Default .gitignore contents — includes all patterns our filter uses,
 * plus common dev artifacts. This is what we auto-create for users who
 * don't have one.
 */
export const DEFAULT_GITIGNORE = `# Dependencies
node_modules/
.pnp/
.pnp.js

# Build output
dist/
out/
build/
.next/
.nuxt/
.cache/
.turbo/
.vercel/
.netlify/
coverage/

# Secrets — NEVER commit these
.env
.env.*
!.env.example
*.pem
*.key
*.p12
*.pfx
service-account*.json
firebase-credentials*.json
credentials*.json
secrets*.json
id_rsa
id_ed25519

# IDE
.idea/
.vscode/
*.swp
.DS_Store

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
`

/**
 * Scans file CONTENTS for hardcoded secrets. Returns a list of findings.
 * Used before GitHub push / Netlify deploy to warn the user if the agent
 * (or the user) accidentally pasted a real credential into source code.
 *
 * Patterns are conservative — only matches formats that are >99% certainly secrets,
 * to avoid false positives on placeholder text like "your-api-key-here".
 */
export interface SecretFinding {
  path: string
  line: number
  kind: string
  snippet: string
}

interface SecretPattern {
  kind: string
  re: RegExp
}

const SECRET_PATTERNS: SecretPattern[] = [
  // Stripe
  { kind: 'Stripe live secret key', re: /sk_live_[0-9a-zA-Z]{24,}/g },
  { kind: 'Stripe restricted key', re: /rk_live_[0-9a-zA-Z]{24,}/g },
  { kind: 'Stripe test secret key', re: /sk_test_[0-9a-zA-Z]{24,}/g },
  // AWS
  { kind: 'AWS Access Key ID', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'AWS Secret Access Key', re: /(?<![A-Za-z0-9/+=])aws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
  // Google
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'Google OAuth client secret', re: /\bGOCSPX-[0-9A-Za-z_-]{28,}\b/g },
  // GitHub
  { kind: 'GitHub personal access token', re: /\bghp_[0-9A-Za-z]{36,}\b/g },
  { kind: 'GitHub OAuth token', re: /\bgho_[0-9A-Za-z]{36,}\b/g },
  { kind: 'GitHub fine-grained PAT', re: /\bgithub_pat_[0-9A-Za-z_]{80,}\b/g },
  // OpenAI / Anthropic
  { kind: 'OpenAI API key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{40,}\b/g },
  { kind: 'Anthropic API key', re: /\bsk-ant-(api03-)?[A-Za-z0-9_-]{80,}\b/g },
  // Slack
  { kind: 'Slack token', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g },
  // Supabase service role
  { kind: 'Supabase service_role JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[^."'\s]{10,}\.[A-Za-z0-9_-]{20,}\b/g },
  // SendGrid / Twilio / Mailgun
  { kind: 'SendGrid API key', re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{30,}\b/g },
  { kind: 'Twilio Account SID', re: /\bAC[a-f0-9]{32}\b/g },
  { kind: 'Mailgun API key', re: /\bkey-[a-f0-9]{32}\b/g },
  // Private keys
  { kind: 'Private key (PEM)', re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  // VajbAgent's own API key format
  { kind: 'VajbAgent API key', re: /\bva-[a-z0-9-]+-[a-f0-9]{8,}\b/g },
]

/**
 * Replaces all matched secrets in file contents with a placeholder.
 * Used as a safety net when the user clicks "Protect and push" — we redact
 * the secrets before sending to GitHub so nothing leaks even if the user
 * ignored the warning.
 */
export function redactSecrets(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== 'string' || content.length > 500_000) {
      out[path] = content
      continue
    }
    let redacted = content
    for (const { re } of SECRET_PATTERNS) {
      re.lastIndex = 0
      redacted = redacted.replace(re, '[REDACTED_BY_VAJBAGENT]')
    }
    out[path] = redacted
  }
  return out
}

export function scanForSecrets(files: Record<string, string>): SecretFinding[] {
  const findings: SecretFinding[] = []
  const SCANNABLE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|json|html|css|scss|md|yml|yaml|toml|sh|env|py|go|rb|java|rs|php|swift|kt)$/i

  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue
    if (content.length > 500_000) continue // skip huge files (likely minified bundles)
    if (!SCANNABLE_EXT.test(path) && !path.includes('.')) continue

    const lines = content.split('\n')
    for (const { kind, re } of SECRET_PATTERNS) {
      re.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = re.exec(content)) !== null) {
        // Find line number
        let pos = 0
        let lineNum = 1
        for (let i = 0; i < lines.length; i++) {
          if (pos + lines[i].length >= match.index) {
            lineNum = i + 1
            break
          }
          pos += lines[i].length + 1 // +1 for \n
        }
        const snippet = match[0].length > 40
          ? match[0].slice(0, 12) + '...' + match[0].slice(-6)
          : match[0]
        findings.push({ path, line: lineNum, kind, snippet })
        if (findings.length >= 50) return findings // cap
      }
    }
  }
  return findings
}

/**
 * Merge the user's existing .gitignore with our required patterns.
 * Returns null if merging isn't needed (user's file already covers everything).
 */
export function ensureGitignoreSafety(existing: string | undefined): string | null {
  const required = ['.env', 'node_modules/', '*.pem', '*.key']
  if (!existing || !existing.trim()) {
    return DEFAULT_GITIGNORE
  }
  const lines = existing.split('\n').map(l => l.trim())
  const missing = required.filter(p => !lines.includes(p) && !lines.some(l => l === p.replace(/\/$/, '')))
  if (missing.length === 0) return null
  return existing.replace(/\n?$/, '\n') +
    `\n# Added by VajbAgent — protects secrets & build artifacts\n${missing.join('\n')}\n`
}
