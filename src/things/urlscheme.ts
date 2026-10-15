export type UrlCommand = 'update' | 'update-project'

/** A things:/// URL. Every value is percent-encoded; empty strings are kept (they clear a field). */
export function thingsUrl(
  command: UrlCommand,
  id: string,
  params: Record<string, string | boolean>,
  authToken: string,
): string {
  const pairs: [string, string][] = [
    ['id', id],
    ...Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]),
    ['auth-token', authToken],
  ]
  return `things:///${command}?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
}
