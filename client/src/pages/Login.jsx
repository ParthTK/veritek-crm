import { useState } from 'react';
import { useAuth } from '../auth.jsx';
import { Button, Field, Input, Notice, Checkbox, Logo } from '../components/ui.jsx';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password, code, remember);
    } catch (err) {
      if (err.details?.mfa_required) setMfa(true);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <div className="login-art">
        <div><Logo plate height={52} /></div>
        <div>
          <h1>Customer & order control, one record at a time.</h1>
          <ul style={{ paddingLeft: 18, lineHeight: 1.6 }}>
            <li>Reconnect with past customers — keep the reason and the next action together.</li>
            <li>Track every enquiry through quotation and decision.</li>
            <li>Keep original promises, current forecasts and what the customer was told.</li>
            <li>See exceptions first: overdue follow-ups, at-risk orders, missing updates.</li>
          </ul>
        </div>
        <div className="small" style={{ opacity: 0.75 }}>Veritek Engineering Private Limited</div>
      </div>
      <div className="login-panel">
        <div className="login-logo"><Logo plate height={40} /></div>
        <div>
          <h1>Sign in</h1>
          <div className="muted">Use your own account — there is no shared login.</div>
        </div>
        <form className="stack-sm" onSubmit={submit}>
          {error && <Notice tone="danger">{error}</Notice>}
          <Field label="Email" htmlFor="email"><Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
          <Field label="Password" htmlFor="password"><Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          {mfa && <Field label="Authenticator code" htmlFor="code" hint="6 digits from your authenticator app"><Input id="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus /></Field>}
          <Checkbox label="Keep me signed in on this computer" checked={remember} onChange={setRemember} />
          <Button type="submit" variant="primary" size="lg" loading={busy} className="block">Sign in</Button>
        </form>
      </div>
    </div>
  );
}
