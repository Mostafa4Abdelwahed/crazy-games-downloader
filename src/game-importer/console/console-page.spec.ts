import { renderConsolePage } from './console-page';

describe('management console page', () => {
  it('renders a complete standalone document', () => {
    const html = renderConsolePage();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('id="sourceUrl"');
    expect(html).toContain('id="startForm"');
    expect(html).toContain('id="jobRows"');
    expect(html).toContain('id="detail"');
  });

  it('drives only the existing public import API', () => {
    const html = renderConsolePage();
    expect(html).toContain('/game-imports');
    expect(html).toContain('python -m http.server 8080');
    expect(html).toContain('http://localhost:8080');
    expect(html).toContain('file://');
    // Must never execute imported game code or inline untrusted URLs.
    expect(html).not.toContain('eval(');
  });

  it('embeds syntactically valid JavaScript', () => {
    const html = renderConsolePage();
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    expect(() => new Function(m?.[1] ?? '')).not.toThrow();
  });
});
