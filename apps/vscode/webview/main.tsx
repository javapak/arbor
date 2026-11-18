import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { startRenderer, WebGPUUnsupported } from 'webgpu-flow';
import '@mantine/core/styles.css';
import 'allotment/dist/style.css';
import './index.css';
import type { HostMessage } from '../src/protocol';
import { useDiagramStore } from './store';
import { post } from './vscode';
import App from './App';

window.addEventListener('message', (e: MessageEvent<HostMessage>) => useDiagramStore.getState().receive(e.data));

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
