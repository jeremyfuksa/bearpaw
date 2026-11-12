import { describe, it, expect } from 'vitest';
import { buildMailto, buildIssueUrl, diagnosticFilename } from '../diagnosticLinks';

function bodyOf(url: string): string {
  return new URL(url).searchParams.get('body') ?? '';
}

describe('diagnosticLinks', () => {
  it('buildMailto puts the report in the body when it fits', () => {
    const text = 'Model: SDS100\nMDL -> MDL,SDS100';
    const url = buildMailto(text, 'SDS100');
    expect(url.startsWith('mailto:info@bearpaw.app?subject=')).toBe(true);
    expect(bodyOf(url)).toBe(text);
    expect(new URL(url).searchParams.get('subject')).toBe('Bearpaw diagnostic: SDS100');
  });

  it('buildMailto falls back to an attach-the-file body when the report is long', () => {
    const text = 'x'.repeat(5000);
    const url = buildMailto(text, 'SDS100');
    expect(url.length).toBeLessThanOrEqual(1800);
    const body = bodyOf(url);
    expect(body).toContain('attach');
    expect(body).toContain('SDS100');
    expect(body).toContain('bearpaw-diagnostic-SDS100-');
    expect(body).not.toContain('xxxx');
  });

  it('buildMailto measures the ENCODED length, not the raw text length', () => {
    // 700 newlines encode to 2100 characters: raw length passes, URL does not.
    const text = '\n'.repeat(700);
    expect(buildMailto(text, 'SDS100').length).toBeLessThanOrEqual(1800);
    expect(bodyOf(buildMailto(text, 'SDS100'))).toContain('attach');
  });

  it('buildIssueUrl targets the bearpaw repo and encodes the title', () => {
    const url = buildIssueUrl('report body', 'SDS 100/X');
    expect(url.startsWith('https://github.com/jeremyfuksa/bearpaw/issues/new?')).toBe(true);
    expect(new URL(url).searchParams.get('title')).toBe('Diagnostic: SDS 100/X');
    expect(bodyOf(url)).toBe('report body');
  });

  it('buildIssueUrl falls back to an attach-the-file body when the report is long', () => {
    const url = buildIssueUrl('y'.repeat(9000), 'SDS100');
    expect(url.length).toBeLessThanOrEqual(6000);
    expect(bodyOf(url)).toContain('attach');
  });

  it('diagnosticFilename gives the model and the date', () => {
    expect(diagnosticFilename('SDS100', new Date(2026, 10, 11, 12))).toBe(
      'bearpaw-diagnostic-SDS100-2026-11-11.txt',
    );
  });
});
