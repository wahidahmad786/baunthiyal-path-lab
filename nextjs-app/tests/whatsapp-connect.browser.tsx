// Local browser harness. API and Meta SDK are supplied by isolated fixtures.
import { createRoot } from 'react-dom/client';
import WhatsAppIntegration from '../components/whatsapp-integration';
import '../app/globals.css';
createRoot(document.getElementById('root')!).render(<WhatsAppIntegration />);
