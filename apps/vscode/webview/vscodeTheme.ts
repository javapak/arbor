import { useRenderSettings } from 'webgpu-flow';

/**
 * Keeps the canvas in the active colour theme: the editor's background behind it, and its
 * foreground for the grid and for edge labels. VS Code sets the theme's colours as
 * --vscode-* variables on the page and swaps them when the theme changes, which this watches.
 */
export function followVsCodeTheme(): void {
    const apply = () => {
        const style = getComputedStyle(document.documentElement);
        const color = (name: string) => style.getPropertyValue(name).trim();
        const background = color('--vscode-editor-background');
        const foreground = color('--vscode-editor-foreground') || color('--vscode-foreground');
        if (!background || !foreground) return;
        const { canvasTheme, setCanvasTheme } = useRenderSettings.getState();
        if (canvasTheme.background === background && canvasTheme.grid === foreground && canvasTheme.text === foreground) return;
        setCanvasTheme({ background, grid: foreground, text: foreground });
    };
    apply();
    // The variables are on <html>'s style; the theme kind is a class on <body>.
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
