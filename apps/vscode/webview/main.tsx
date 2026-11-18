import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { setLayoutWorker, startRenderer, WebGPUUnsupported } from 'webgpu-flow';
import '@mantine/core/styles.css';
import 'allotment/dist/style.css';
import './index.css';
import type { HostMessage } from '../src/protocol';
import { useDiagramStore } from './store';
import { post } from './vscode';
import App from './App';

window.addEventListener('message', (e: MessageEvent<HostMessage>) => useDiagramStore.getState().receive(e.data));

// ELK's layout worker ships next to this bundle; the page only allows blob: workers, so run it from one.
const elkWorker = document.getElementById('root')!.dataset.elkWorker;
if (elkWorker) {
    void fetch(elkWorker).then(r => r.text()).then(code => {
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        setLayoutWorker(() => new Worker(url));
        useDiagramStore.setState({ layoutReady: true });
    }).catch(e => useDiagramStore.getState().setNotice(`Automatic layout is unavailable: ${String(e)}`));
}

const failure = await startRenderer();

function Root() {
    const dark = useDiagramStore(s => s.dark);
    return (
        <MantineProvider forceColorScheme={dark ? 'dark' : 'light'}>
            {failure ? <WebGPUUnsupported reason={failure} /> : <App />}
        </MantineProvider>
    );
}

createRoot(document.getElementById('root')!).render(<Root />);
post({ type: 'ready' });
