import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useSave } from '../lib/hooks.js';
import { Button, Card, Field, Input, Notice, PageHeader, SaveStatus, useToast } from '../components/ui.jsx';
import { roleLabel } from '../components/domain.jsx';

export default function Account() {
  const { user, replaceSession } = useAuth();
  const toast = useToast();
  const save = useSave();
  const mfaSave = useSave();
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [disablePw, setDisablePw] = useState('');
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <PageHeader title="Password & sign-in security" subtitle={`${user.name} · ${roleLabel(user.role)}`} />
      {user.must_change_password && <Notice tone="warn" title="Set your own password">Your password was set by an administrator. Choose a new one to continue.</Notice>}
      <Card title="Change password">
        <form className="stack-sm" onSubmit={(e) => {
          e.preventDefault();
          if (pw.next !== pw.confirm) {
            toast.error('The new passwords do not match');
            return;
          }
          save.run(async () => {
            const res = await api.post('/auth/password', { current: pw.current, next: pw.next });
            replaceSession(res);
            setPw({ current: '', next: '', confirm: '' });
            toast.success('Password changed. Other sessions were signed out.');
          });
        }}>
          <Field label="Current password" error={save.fields.current}><Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
          <Field label="New password" hint="At least 8 characters, with a letter and a number" error={save.fields.next}><Input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
          <Field label="Repeat new password"><Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
          <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Change password</Button></div>
        </form>
      </Card>
      <Card title="Two-step sign-in (authenticator app)" sub={user.mfa_enabled ? 'On' : 'Off'}>
        {user.mfa_enabled ? (
          <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); mfaSave.run(async () => { await api.post('/auth/mfa/disable', { password: disablePw }); toast.success('Two-step sign-in turned off'); window.location.reload(); }); }}>
            <Notice tone="success">Two-step sign-in is on for your account.</Notice>
            <Field label="Confirm with your password to turn it off" error={mfaSave.fields.password}><Input type="password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} /></Field>
            <div className="row between"><SaveStatus save={mfaSave} /><Button type="submit" variant="danger-ghost" loading={mfaSave.saving}>Turn off</Button></div>
          </form>
        ) : setup ? (
          <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); mfaSave.run(async () => { await api.post('/auth/mfa/enable', { secret: setup.secret, code }); toast.success('Two-step sign-in is on'); window.location.reload(); }); }}>
            <div className="small">Add this key to Google Authenticator, Microsoft Authenticator or similar (choose “enter a setup key”, time-based):</div>
            <div className="mono" style={{ fontSize: 15, letterSpacing: '0.08em', userSelect: 'all', padding: 10, background: 'var(--surface-3)', borderRadius: 8 }}>{setup.secret.match(/.{1,4}/g).join(' ')}</div>
            <Field label="Enter the 6-digit code it shows" error={mfaSave.fields.code}><Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            <div className="row between"><SaveStatus save={mfaSave} /><Button type="submit" variant="primary" loading={mfaSave.saving}>Turn on</Button></div>
          </form>
        ) : (
          <div className="stack-sm">
            <div className="small muted">Recommended for administrators: a code from your phone is needed at each sign-in.</div>
            <div><Button onClick={async () => setSetup(await api.post('/auth/mfa/setup'))}>Set up two-step sign-in</Button></div>
          </div>
        )}
      </Card>
    </div>
  );
}
