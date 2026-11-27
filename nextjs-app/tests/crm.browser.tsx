// Isolated browser regression harness; production never imports this file.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import TemplateManager from '../components/template-manager';
import TeamSettings from '../components/team-settings';
import ConnectionAlerts from '../components/connection-alerts';
import WhatsAppInbox from '../components/whatsapp-inbox';
import '../app/globals.css';
function Harness() {
  const [page, setPage] = useState('templates');
  return (
    <div style={{ padding: 18, maxWidth: 1300, margin: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {['templates', 'team', 'inbox'].map((p) => (
            <button className="button secondary" key={p} onClick={() => setPage(p)}>
              {p}
            </button>
          ))}
        </div>
        <ConnectionAlerts
          bookings={1}
          onOpenBookings={() => {
            document.body.dataset.bookings = 'open';
          }}
          onOpenIntegration={() => {
            document.body.dataset.integration = 'open';
          }}
          onHealthy={() => {}}
        />
      </div>
      {page === 'templates' && (
        <TemplateManager
          onOpenIntegration={() => {
            document.body.dataset.integration = 'open';
          }}
        />
      )}
      {page === 'team' && <TeamSettings onOpenInbox={() => setPage('inbox')} />}
      {page === 'inbox' && (
        <WhatsAppInbox
          customers={[
            {
              id: 'a'.repeat(32),
              name: 'Owner fixture customer',
              phone: '919876543210',
              createdAt: new Date().toISOString(),
              groups: [],
              testIds: [],
              marketing: { status: 'not_asked', source: 'Fixture', at: new Date().toISOString() },
            },
          ]}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
