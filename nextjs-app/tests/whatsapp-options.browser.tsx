// Browser regression harness only. Never imported by application source.
import { createRoot } from 'react-dom/client';
import WhatsAppConnectionOptions from '../components/whatsapp-connection-options';
import '../app/globals.css';
createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 20, maxWidth: 1200, margin: 'auto' }}>
    <WhatsAppConnectionOptions />
  </main>,
);
