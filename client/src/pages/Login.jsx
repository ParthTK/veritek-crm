import { useState } from 'react';
import { useAuth } from '../auth.jsx';
import { Button, Field, Input } from '../components/ui.jsx';

const DEMO = [
  ['admin@veritek.example', 'Super Admin'],
  ['md@veritek.example', 'Management'],
  ['saleshead@veritek.example', 'Sales Head'],
  ['rsm.west@veritek.example', 'Regional Manager (West)'],
  ['rohan@veritek.example', 'Sales Executive'],
  ['commercial@veritek.example', 'Commercial'],
  ['production@veritek.example', 'Production (Unit 1)'],
  ['quality@veritek.example', 'Quality'],
  ['dispatch@veritek.example', 'Dispatch'],
  ['accounts@veritek.example', 'Accounts'],
  ['service@veritek.example', 'Service'],
];

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-art">
        <div className="row" style={{ gap: 10 }}>
          <span className="brand-mark"><svg width="18" height="18" viewBox="0 0 32 32" aria-hidden><path d="M8 9l8 15 8-15" stroke="white" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
          <strong style={{ color: '#fff' }}>Veritek Energy Systems</strong>
        </div>
        <div>
          <h1>Every enquiry, quotation, order and rupee, from first call to repeat business.</h1>
          <p style={{ maxWidth: 480, opacity: 0.85 }}>Sales, commercial, production, dispatch, accounts and service teams share one live view of each customer relationship.</p>
          <div className="journey">
            {['Lead', 'Requirement', 'Quotation', 'Negotiation', 'Purchase order', 'Production', 'Quality check', 'Dispatch', 'Payment', 'Service', 'Repeat order'].map((s) => <span key={s}>{s}</span>)}
          </div>
        </div>
        <div className="small" style={{ opacity: 0.6 }}>Manufacturing sales & order CRM</div>
      </div>
      <div className="login-panel">
        <form onSubmit={submit} className="stack" style={{ maxWidth: 380, width: '100%', margin: '0 auto' }}>
          <div>
            <h1>Sign in</h1>
            <p className="muted" style={{ marginTop: 4 }}>Use your work email</p>
          </div>
          {error && <div className="error-box">{error}</div>}
          <Field label="Email"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
          <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          <Button variant="primary" loading={busy} type="submit" style={{ height: 40 }}>Sign in</Button>
          <div>
            <div className="small muted">Demo accounts (password <span className="mono">Veritek@123</span>) — each role sees its own workspace:</div>
            <div className="demo-users">
              {DEMO.map(([e, role]) => (
                <button key={e} type="button" onClick={() => { setEmail(e); setPassword('Veritek@123'); }}>
                  <div className="strong">{role}</div>
                  <div className="muted tiny truncate">{e}</div>
                </button>
              ))}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
