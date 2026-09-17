import { useState } from 'react';
import { ROLES, labelOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { dateTime } from '../lib/format.js';
import { Button, Card, Field, Input, KV, PageHeader, useToast } from '../components/ui.jsx';

export default function Account() {
  const { user } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (form.next !== form.confirm) {
      toast.error('New passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/password', { current: form.current, next: form.next });
      toast.success('Password changed — other sessions have been signed out');
      setForm({});
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ maxWidth: 620 }}>
      <PageHeader title="My account" subtitle="Your profile and password" />
      <Card title="Profile">
        <KV items={[
          ['Name', user.name],
          ['Email', user.email],
          ['Role', labelOf(ROLES, user.role)],
          ['Designation', user.designation],
          ['Region', user.region_name || 'All regions'],
          ['Factory / unit', user.factory_name],
          ['Branch', user.branch],
          ['Last sign-in', user.last_login_at ? dateTime(user.last_login_at) : '—'],
        ]} />
      </Card>
      <Card title="Change password" actions={<Button variant="primary" size="sm" loading={busy} onClick={submit}>Update password</Button>}>
        <div className="form-grid">
          <Field label="Current password" className="full"><Input type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm((f) => ({ ...f, current: e.target.value }))} /></Field>
          <Field label="New password" hint="At least 8 characters"><Input type="password" autoComplete="new-password" value={form.next} onChange={(e) => setForm((f) => ({ ...f, next: e.target.value }))} /></Field>
          <Field label="Confirm new password"><Input type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))} /></Field>
        </div>
      </Card>
    </div>
  );
}
