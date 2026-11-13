import { createRoot } from 'react-dom/client';
import WhatsAppInbox from '../components/whatsapp-inbox';
import '../app/globals.css';
const id = 'a'.repeat(32);
createRoot(document.getElementById('root')!).render(
  <WhatsAppInbox
    customers={[
      {
        id,
        name: 'Fixture Customer',
        phone: '919876543210',
        createdAt: new Date().toISOString(),
        groups: [],
        testIds: [],
        marketing: { status: 'not_asked', at: new Date().toISOString(), source: 'Browser fixture' },
      },
    ]}
    selectedCustomerId={id}
    onOpenIntegration={() => {
      document.body.dataset.openIntegration = 'true';
    }}
  />,
);
