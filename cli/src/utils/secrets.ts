const PATTERNS: RegExp[] = [
  // API keys: OpenAI, Anthropic, GitHub, AWS, Stripe, etc.
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  /ghp_[a-zA-Z0-9]{36,}/g,
  /gho_[a-zA-Z0-9]{36,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /sk_live_[a-zA-Z0-9]{24,}/g,
  /rk_live_[a-zA-Z0-9]{24,}/g,
  /xoxb-[a-zA-Z0-9-]+/g,
  /xoxp-[a-zA-Z0-9-]+/g,

  // Bearer tokens
  /Bearer\s+[a-zA-Z0-9._\-\/+=]{20,}/gi,

  // Connection strings with passwords
  /(?:postgres(?:ql)?|mysql|mongodb|redis):\/\/[^:]+:[^@]+@[^\s"']+/gi,

  // Generic KEY=value patterns (env vars)
  /(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_KEY|AUTH)\s*[=:]\s*['"]?[a-zA-Z0-9._\-\/+=]{8,}['"]?/gi,

  // JWTs (three base64 segments separated by dots)
  /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
];

const MASK = "***MASKED***";

export function maskSecrets(text: string): string {
  let masked = text;
  for (const pattern of PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    masked = masked.replace(pattern, MASK);
  }
  return masked;
}
