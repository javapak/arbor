import * as vscode from 'vscode';

export function isDark(theme: vscode.ColorTheme): boolean {
    return theme.kind === vscode.ColorThemeKind.Dark || theme.kind === vscode.ColorThemeKind.HighContrast;
}

/**
 * A webview page running `media/<bundle>.js` with its stylesheet. No
 * 'unsafe-eval' (the project's no-eval rule holds here too); inline styles are
 * allowed because Mantine injects its CSS variables at runtime.
 */
export function webviewPage(webview: vscode.Webview, media: vscode.Uri, bundle: string, title: string): string {
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
    const csp = [
        `default-src 'none'`,
        `script-src 'nonce-${nonce}'`,
        `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
        `font-src ${webview.cspSource} https://fonts.gstatic.com`,
        `img-src ${webview.cspSource} data: blob:`,
        `worker-src blob:`,
    ].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset(`${bundle}.css`)}">
  <title>${title}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${asset(`${bundle}.js`)}"></script>
</body>
</html>`;
}
