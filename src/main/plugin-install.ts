// Marketplace "install from git": parse + validate a plugin repo URL into a safe install name.
// Pure + exported so the host/scheme allowlist and the path-safety of the derived name are
// unit-testable. The name becomes a directory under ~/.deepcode/plugins, so it must never be a
// traversal token (`.`/`..`) or contain a separator — otherwise the clone would escape the dir.

const REPO_URL = /^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/[\w.-]+\/([\w.-]+?)(\.git)?\/?$/

// Returns the safe repo name to install as, or null if the URL is not an allowed https repo URL
// or the derived name is unsafe.
export function parsePluginRepoUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const m = url.trim().match(REPO_URL)
  if (!m) return null
  const name = m[2]
  // the char class [\w.-] can still match a pure-dot token like "." or ".." — those would resolve
  // the install dir to the plugins root or its PARENT. Reject any name that isn't a real segment.
  if (!name || name === '.' || name === '..' || !/[\w]/.test(name) || /^\.+$/.test(name)) return null
  return name
}

// The hardened `git clone` argv for an untrusted repo: shallow, no tags, file-transport blocked
// (no file:// submodule exfiltration), submodule recursion off.
export function pluginCloneArgs(url: string, dest: string): string[] {
  return [
    'clone',
    '--depth',
    '1',
    '--no-tags',
    '-c',
    'protocol.file.allow=never',
    '-c',
    'submodule.recurse=false',
    url.trim(),
    dest
  ]
}
