// Where a diagnostic report goes. Both links carry the report in the URL when
// it fits and a short "attach the file" note when it does not: mail clients and
// GitHub both truncate or refuse a very long URL, and a half-cut report is
// worse than none.

export const REPORT_EMAIL = 'info@bearpaw.app';
const ISSUE_NEW_URL = 'https://github.com/jeremyfuksa/bearpaw/issues/new';

/** Longest `mailto:` URL, encoded, we hand to a mail client. */
export const MAILTO_MAX = 1800;
/** Longest issue URL, encoded. GitHub rejects a request line past ~8 KB. */
export const ISSUE_MAX = 6000;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `bearpaw-diagnostic-{model}-{YYYY-MM-DD}.txt`, dated in the user's local day. */
export function diagnosticFilename(model: string, now: Date): string {
  const safeModel = model.replace(/[^A-Za-z0-9._-]+/g, '-');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `bearpaw-diagnostic-${safeModel}-${date}.txt`;
}

function attachNote(model: string): string {
  return (
    `Bearpaw ran a read-only diagnostic on my ${model}. The report is too long ` +
    `to fit in this message, so please attach the file I saved: ` +
    `${diagnosticFilename(model, new Date())}`
  );
}

function withBody(
  base: string,
  params: Record<string, string>,
  text: string,
  model: string,
  max: number,
): string {
  const build = (body: string) =>
    `${base}${Object.entries({ ...params, body })
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&')}`;
  // The ENCODED length is what the client sees: a newline is three characters
  // there, so the raw length of the text says nothing about whether it fits.
  const full = build(text);
  return full.length <= max ? full : build(attachNote(model));
}

export function buildMailto(text: string, model: string): string {
  return withBody(
    `mailto:${REPORT_EMAIL}?`,
    { subject: `Bearpaw diagnostic: ${model}` },
    text,
    model,
    MAILTO_MAX,
  );
}

export function buildIssueUrl(text: string, model: string): string {
  return withBody(`${ISSUE_NEW_URL}?`, { title: `Diagnostic: ${model}` }, text, model, ISSUE_MAX);
}
