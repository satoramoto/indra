const KEY = String.raw`[A-Za-z0-9_-]*(?:token|password|passwd|secret|api[_-]?key)[A-Za-z0-9_-]*`;

/** Removes anything token-shaped from free text before it is logged or stored. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, "[redacted]")
    .replace(/\bops_[A-Za-z0-9_+/=.-]+/g, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+@/g, "$1[redacted]@")
    .replace(/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]+/gi, "$1$2[redacted]")
    .replace(new RegExp(String.raw`\b(${KEY})(\s+)[a-z0-9]{26}\b`, "gi"), "$1$2[redacted]")
    .replace(new RegExp(String.raw`\b(${KEY})(["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"'&,;]+`, "gi"), "$1$2[redacted]")
    .replace(/[A-Za-z0-9+_=-]{32,}/g, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? "[redacted]" : run));
}
