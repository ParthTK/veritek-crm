// The page behind a QR code: no login, mobile first, and nothing but the object's information.
import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { date, fileSize } from '../lib/format.js';
import { Button, Field, Input, Notice, Spinner, useToast } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';

const KIND_ICON = { pdf: 'file', image: 'eye', sheet: 'reports', csv: 'reports', doc: 'note', text: 'note', video: 'video', audio: 'mic', download: 'download' };

function kindOf(file) {
  const ext = (file.name || '').toLowerCase().split('.').pop();
  const mime = file.mime || '';
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(ext)) return 'image';
  if (mime.startsWith('video/') || ['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'ogg'].includes(ext)) return 'audio';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (['xlsx', 'xlsm'].includes(ext)) return 'sheet';
  if (['csv', 'tsv'].includes(ext)) return 'csv';
  if (ext === 'docx') return 'doc';
  if (mime.startsWith('text/') || ['txt', 'md', 'json', 'log'].includes(ext)) return 'text';
  return 'download';
}

export default function ScanPage() {
  const { publicId } = useParams();
  const [params] = useSearchParams();
  const [state, setState] = useState({ loading: true });
  const [unlock, setUnlock] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (token) => {
    try {
      const data = await api.get(`/public/objects/${publicId}`, { unlock: token || undefined, src: params.get('src') || undefined });
      setState({ ...data, loading: false });
    } catch (err) {
      setState({ state: err.status === 404 ? 'unknown' : 'error', error: err.message, loading: false });
    }
  }, [publicId, params]);

  useEffect(() => {
    load();
  }, [load]);

  const submitPassword = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.post(`/public/objects/${publicId}/unlock`, { password });
      setUnlock(res.unlock);
      setState({ state: 'ok', object: res.object, branding: res.branding, loading: false });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <div className="scan-shell"><Spinner /></div>;
  const brand = state.branding || {};

  if (state.state === 'locked') {
    return (
      <Shell brand={brand}>
        <form className="scan-card scan-gate" onSubmit={submitPassword}>
          <Icon name="shield" size={28} />
          <h1>{state.name}</h1>
          <p className="muted">This information is password protected.</p>
          {error && <Notice tone="danger">{error}</Notice>}
          <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></Field>
          <Button variant="primary" type="submit" loading={busy} style={{ width: '100%', height: 42 }}>View information</Button>
        </form>
      </Shell>
    );
  }

  if (state.state === 'private') {
    return (
      <Shell brand={brand}>
        <div className="scan-card scan-gate">
          <Icon name="shield" size={28} />
          <h1>{state.name}</h1>
          <p className="muted">This object is private. Sign in with your work account to view it.</p>
          <Button to="/login" variant="primary" style={{ width: '100%', height: 42 }}>Sign in</Button>
        </div>
      </Shell>
    );
  }

  if (state.state === 'archived') {
    return (
      <Shell brand={brand}>
        <div className="scan-card scan-gate">
          <Icon name="box" size={28} />
          <h1>{state.name}</h1>
          <p className="muted">{state.message}</p>
        </div>
      </Shell>
    );
  }

  if (state.state !== 'ok') {
    return (
      <Shell brand={brand}>
        <div className="scan-card scan-gate">
          <Icon name="search" size={28} />
          <h1>Code not in use</h1>
          <p className="muted">{state.error || 'Nothing is published at this code.'}</p>
        </div>
      </Shell>
    );
  }

  const o = state.object;
  return (
    <Shell brand={brand}>
      <article className="scan-card">
        {o.image && <img className="scan-hero" src={`/api/public/objects/${publicId}/image`} alt="" onError={(e) => { e.target.style.display = 'none'; }} />}
        <header className="scan-head">
          {o.category && <span className="scan-chip">{o.category}</span>}
          <h1>{o.name}</h1>
          {o.description && <p className="scan-desc">{o.description}</p>}
          <div className="scan-meta">
            <span className="mono">{o.public_id}</span>
            {o.location && <span>· {o.location}</span>}
            {o.owner && <span>· {o.owner}</span>}
            {o.serial_number && <span>· SN {o.serial_number}</span>}
          </div>
        </header>

        {o.fields.length > 0 && (
          <section className="scan-fields">
            {o.fields.map((f) => (
              <div key={f.key}>
                <div className="scan-label">{f.label}</div>
                <div className="scan-value">{renderValue(f)}</div>
              </div>
            ))}
          </section>
        )}

        {o.files.length > 0 && (
          <section className="scan-files">
            <h2>{o.files.length === 1 ? 'Document' : `Documents (${o.files.length})`}</h2>
            {o.files.map((f) => (
              <FileCard key={f.id} publicId={publicId} file={f} unlock={unlock} openByDefault={o.single_file_direct || o.files.length === 1} />
            ))}
          </section>
        )}

        {!o.files.length && !o.fields.length && !o.description && <p className="muted" style={{ textAlign: 'center', padding: 24 }}>No information has been published for this item yet.</p>}

        {o.updated_at && <footer className="scan-foot">Last updated {date(o.updated_at)}</footer>}
      </article>
    </Shell>
  );
}

function renderValue(f) {
  if (f.type === 'checkbox') return f.value ? 'Yes' : 'No';
  if (f.type === 'url') return <a href={f.value} target="_blank" rel="noreferrer">{f.value}</a>;
  if (f.type === 'email') return <a href={`mailto:${f.value}`}>{f.value}</a>;
  if (f.type === 'phone') return <a href={`tel:${String(f.value).replace(/\s/g, '')}`}>{f.value}</a>;
  if (f.type === 'date') return date(f.value);
  if (f.type === 'notes') return <span style={{ whiteSpace: 'pre-wrap' }}>{f.value}</span>;
  return String(f.value);
}

function Shell({ brand, children }) {
  return (
    <div className="scan-shell" style={brand.color ? { '--accent': brand.color } : undefined}>
      <div className="scan-brand">{brand.name}</div>
      {children}
      <div className="scan-contact">
        {brand.phone && <a href={`tel:${brand.phone.replace(/\s/g, '')}`}>{brand.phone}</a>}
        {brand.email && <a href={`mailto:${brand.email}`}>{brand.email}</a>}
        {brand.website && <a href={`https://${String(brand.website).replace(/^https?:\/\//, '')}`} target="_blank" rel="noreferrer">{brand.website}</a>}
      </div>
    </div>
  );
}

function FileCard({ publicId, file, unlock, openByDefault }) {
  const kind = kindOf(file);
  const [open, setOpen] = useState(Boolean(openByDefault));
  const toast = useToast();
  const query = unlock ? `?unlock=${encodeURIComponent(unlock)}` : '';
  const rawUrl = `/api/public/objects/${publicId}/files/${file.id}/raw${query}`;
  const downloadUrl = `${rawUrl}${query ? '&' : '?'}download=1`;

  return (
    <div className="scan-file">
      <button type="button" className="scan-file-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="scan-file-icon"><Icon name={KIND_ICON[kind] || 'file'} size={18} /></span>
        <span className="grow">
          <span className="scan-file-title">{file.title}</span>
          {file.description && <span className="scan-file-sub">{file.description}</span>}
          <span className="scan-file-sub">{(file.name || '').split('.').pop()?.toUpperCase()} · {fileSize(file.size)}{file.version_no > 1 ? ` · v${file.version_no}` : ''}</span>
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
      </button>
      {open && (
        <div className="scan-file-body">
          <Preview kind={kind} rawUrl={rawUrl} publicId={publicId} file={file} unlock={unlock} />
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <a className="btn sm" href={rawUrl} target="_blank" rel="noreferrer"><Icon name="eye" size={14} /> Open</a>
            <a className="btn sm" href={downloadUrl}><Icon name="download" size={14} /> Download</a>
            <Button size="sm" icon="link" onClick={() => {
              navigator.clipboard?.writeText(`${window.location.origin}${rawUrl}`);
              toast.success('Link copied');
            }}>Copy link</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Preview({ kind, rawUrl, publicId, file, unlock }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!['sheet', 'csv', 'doc', 'text'].includes(kind)) return;
    api.get(`/public/objects/${publicId}/files/${file.id}/preview`, { unlock: unlock || undefined })
      .then(setData, (err) => setError(err.message));
  }, [kind, publicId, file.id, unlock]);

  if (kind === 'pdf') return <iframe className="scan-frame" src={rawUrl} title={file.title} />;
  if (kind === 'image') return <img className="scan-image" src={rawUrl} alt={file.title} />;
  if (kind === 'video') return <video className="scan-video" src={rawUrl} controls preload="metadata" />;
  if (kind === 'audio') return <audio src={rawUrl} controls style={{ width: '100%' }} />;
  if (error) return <div className="muted small">Preview unavailable — download the file instead.</div>;
  if (!data) return <div className="muted small">Loading preview…</div>;
  if (data.kind === 'download' || data.error) return <div className="muted small">This file can be downloaded, but not previewed here.</div>;
  if (data.sheets) {
    return (
      <div className="stack-sm">
        {data.sheets.map((sheet) => (
          <div key={sheet.name}>
            {data.sheets.length > 1 && <div className="scan-label" style={{ marginBottom: 4 }}>{sheet.name}</div>}
            <div className="scan-table-wrap">
              <table className="scan-table">
                <tbody>
                  {sheet.rows.map((row, i) => (
                    <tr key={i}>{row.map((cell, j) => (i === 0 ? <th key={j}>{cell}</th> : <td key={j}>{cell}</td>))}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sheet.truncated && <div className="tiny muted">Showing the first {sheet.rows.length} rows — download the file for everything.</div>}
          </div>
        ))}
      </div>
    );
  }
  if (data.blocks) {
    return (
      <div className="scan-doc">
        {data.blocks.map((b, i) => {
          if (b.type === 'h1') return <h3 key={i}>{b.text}</h3>;
          if (b.type === 'h2' || b.type === 'h3') return <h4 key={i}>{b.text}</h4>;
          if (b.type === 'li') return <li key={i}>{b.text}</li>;
          return <p key={i}>{b.text}</p>;
        })}
        {data.tables > 0 && <div className="tiny muted">This document also contains {data.tables} table{data.tables === 1 ? '' : 's'} — download it to see them.</div>}
      </div>
    );
  }
  if (data.text !== undefined) return <pre className="scan-pre">{data.text}</pre>;
  return <div className="muted small">Download the file to view it.</div>;
}
