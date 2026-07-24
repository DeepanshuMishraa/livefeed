type PageKind = "success" | "error";

export function authorizationPage(kind: PageKind, detail?: string): string {
  const success = kind === "success";
  const title = success ? "Authorization successful" : "Authorization did not finish";
  const description = success
    ? "Livefeed is connected. You can close this tab and return to your terminal."
    : (detail ?? "Return to your terminal and run the authentication command again.");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${title} · livefeed</title>
    <style>
      :root {
        color-scheme: light dark;
        --canvas: #f7f6f3;
        --surface: #ffffff;
        --text: #252522;
        --muted: #73716b;
        --border: #deddd8;
        --status: #3f6b45;
        --status-bg: #edf3ec;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --canvas: #1c1c1a;
          --surface: #242422;
          --text: #f1f0eb;
          --muted: #aaa8a0;
          --border: #3c3b37;
          --status: #a8c9aa;
          --status-bg: #28372a;
        }
      }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        background: var(--canvas);
        color: var(--text);
        font-family: "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
      }
      main {
        width: min(100%, 520px);
        padding: 36px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
      }
      .brand {
        margin: 0 0 48px;
        color: var(--muted);
        font: 600 13px/1 "SF Mono", "Geist Mono", monospace;
        letter-spacing: 0.02em;
      }
      .status {
        display: inline-block;
        margin-bottom: 18px;
        padding: 6px 9px;
        border-radius: 5px;
        background: ${success ? "var(--status-bg)" : "#fdebec"};
        color: ${success ? "var(--status)" : "#9f2f2d"};
        font: 600 12px/1 "SF Mono", "Geist Mono", monospace;
        letter-spacing: 0.03em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        font-size: clamp(28px, 7vw, 40px);
        line-height: 1.08;
        letter-spacing: -0.035em;
      }
      p {
        max-width: 42ch;
        margin: 18px 0 0;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.6;
      }
      @media (max-width: 480px) {
        main { padding: 28px; }
        .brand { margin-bottom: 40px; }
      }
    </style>
  </head>
  <body>
    <main>
      <p class="brand">livefeed</p>
      <span class="status">${success ? "Connected" : "Not connected"}</span>
      <h1>${title}</h1>
      <p>${escapeHtml(description)}</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
