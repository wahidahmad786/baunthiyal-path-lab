// Synthetic browser regression harness. Never imported by application source.
import { createRoot } from 'react-dom/client';
import WhatsAppInbox from '../components/whatsapp-inbox';
import '../app/globals.css';
createRoot(document.getElementById('root')!).render(<main style={{padding:16,maxWidth:1300,margin:'auto'}}><WhatsAppInbox customers={[]} onOpenIntegration={()=>{document.body.dataset.connection='open';}}/></main>);
