import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type { IRDocument } from '@arbor/ir';
import '@mantine/core/styles.css';
import './vscode-theme.css';
import './properties.css';
import type { PropertiesHostMessage } from '../src/protocol';
import { post } from './vscode';
import PropertiesPanel from './PropertiesPanel';

/** The properties view's page: whatever the host last sent, drawn as a form. */
function Root() {
    const [state, setState] = useState<{ ir: IRDocument | null; id: string | null }>({ ir: null, id: null });
    const [dark, setDark] = useState(true);
    useEffect(() => {
        const receive = (e: MessageEvent<PropertiesHostMessage>) => {
            if (e.data.type === 'properties') setState({ ir: e.data.ir, id: e.data.id });
            else setDark(e.data.dark);
        };
        window.addEventListener('message', receive);
        post({ type: 'ready' });
        return () => window.removeEventListener('message', receive);
    }, []);
    return (
        <MantineProvider forceColorScheme={dark ? 'dark' : 'light'}>
            <PropertiesPanel ir={state.ir} id={state.id} />
        </MantineProvider>
    );
}

createRoot(document.getElementById('root')!).render(<Root />);
