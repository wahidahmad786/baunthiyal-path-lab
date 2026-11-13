import { createRoot } from 'react-dom/client';
import { CampaignForm } from '../components/forms';
import '../app/globals.css';
const data = {
  campaigns: [],
  customers: [],
  bookings: [],
  tests: [],
  offers: [],
  totalCustomers: 0,
  optedIn: 0,
};
const config = {
  firebase: false,
  whatsapp: false,
  rate: null,
  labPhone: '+916395951791',
  publicForms: false,
  cron: false,
  clientAuth: true,
  accountCustomers: true,
  accountWhatsApp: true,
  accountCatalog: true,
  accountInbox: true,
};
createRoot(document.getElementById('root')!).render(
  <CampaignForm
    existing={null}
    data={data}
    config={config}
    ready={false}
    accountWhatsApp
    onClose={() => {}}
    onDone={async () => {}}
  />,
);
