import Link from 'next/link';
import { LegalLinks } from './legal-links';
import { ArrowRight, FlaskConical, HeartPulse, ShieldCheck, Users } from 'lucide-react';
export default function PublicHome() {
  return (
    <div className="lab-home">
      <header className="lab-home-header">
        <Link href="/" className="public-brand">
          <img src="/logo.svg" width={48} height={48} alt="Baunthiyal Path Lab" />
          <div>
            <strong>Baunthiyal Path Lab</strong>
            <span>Your Health, Our Priority</span>
          </div>
        </Link>
        <Link href="/login/" className="button primary">
          Sign in <ArrowRight size={16} />
        </Link>
      </header>
      <main className="lab-home-main">
        <div className="lab-home-copy">
          <span className="eyebrow">CARE. CONNECT. GROW.</span>
          <h1>
            Better health.
            <br />
            <em>Closer connections.</em>
          </h1>
          <p>
            A thoughtful workspace for patient care, health offers, and meaningful conversations
            with your community.
          </p>
          <Link href="/login/" className="button primary">
            Sign in with Google <ArrowRight size={18} />
          </Link>
          <span className="lab-home-caption">
            <ShieldCheck size={15} /> Your workspace, securely in one place.
          </span>
        </div>
        <div className="lab-home-art" aria-hidden="true">
          <div className="lab-home-orbit" />
          <div className="lab-home-symbol">
            <FlaskConical size={86} strokeWidth={1.3} />
            <span>BAUNTHIYAL PATH LAB</span>
          </div>
          <span className="lab-home-float first">
            <HeartPulse size={21} />
            Care that connects
          </span>
          <span className="lab-home-float second">
            <Users size={21} />A healthier community
          </span>
        </div>
      </main>
      <div className="lab-home-benefits">
        <div>
          <FlaskConical size={22} />
          <strong>Patient care</strong>
          <span>Keep every health journey organized.</span>
        </div>
        <div>
          <HeartPulse size={22} />
          <strong>Meaningful outreach</strong>
          <span>Bring preventive care closer.</span>
        </div>
        <div>
          <ShieldCheck size={22} />
          <strong>Trusted communication</strong>
          <span>Connect with care and consent.</span>
        </div>
      </div>
      <footer className="lab-home-footer">
        © {new Date().getFullYear()} Baunthiyal Path Lab · Your Health, Our Priority
        <LegalLinks />
      </footer>
    </div>
  );
}
