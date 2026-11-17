import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { startRenderer, WebGPUUnsupported } from 'webgpu-flow';
import '@mantine/core/styles.css';
import 'allotment/dist/style.css';
import './index.css';
import Studio from './Studio';

const failure = await startRenderer();

createRoot(document.getElementById('root')!).render(
  <MantineProvider defaultColorScheme="dark">
    {failure ? <WebGPUUnsupported reason={failure} /> : <Studio />}
  </MantineProvider>
);
