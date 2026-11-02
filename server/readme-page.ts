// Publishes README.md verbatim (HTML-escaped) at /readme/, the same contract
// the busybox placeholder's Dockerfile comment describes: render it however
// you like, as long as every heading is there in full — spec/invariants.test.ts
// checks the headings appear in order in the served HTML.
const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderReadmePage(readmeMarkdown: string): string {
  return `<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>About</title>
  </head>
  <body>
    <main>
      <h1>About</h1>
      <pre>
${escapeHtml(readmeMarkdown)}
      </pre>
    </main>
  </body>
</html>
`;
}
