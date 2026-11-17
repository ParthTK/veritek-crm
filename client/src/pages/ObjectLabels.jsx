// Print-ready labels: a grid the browser prints (or saves as PDF) for one or hundreds of objects.
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi, useBlobUrl } from '../lib/hooks.js';
import { Button, Card, Checkbox, PageHeader, Select, Spinner, EmptyState } from '../components/ui.jsx';

const SIZES = [
  { value: 'small', label: 'Small (6 per row)', columns: 6, code: 86 },
  { value: 'medium', label: 'Medium (4 per row)', columns: 4, code: 118 },
  { value: 'large', label: 'Large (3 per row)', columns: 3, code: 150 },
];

export default function ObjectLabels() {
  const [params] = useSearchParams();
  const ids = (params.get('ids') || '').split(',').map(Number).filter(Boolean);
  const { data: settings } = useApi('/objects/settings');
  const { data } = useApi(ids.length ? '/objects' : null, { pageSize: 500, status: 'all' });
  const [type, setType] = useState(params.get('type') === 'barcode' ? 'barcode' : 'qr');
  const [size, setSize] = useState('medium');
  const [show, setShow] = useState({ name: true, id: true, company: true });

  if (!data || !settings) return <Spinner />;
  const objects = ids.map((id) => data.rows.find((o) => o.id === id)).filter(Boolean);
  const spec = SIZES.find((s) => s.value === size);

  return (
    <div className="stack">
      <div className="no-print">
        <PageHeader
          crumbs={[{ label: 'Objects & QR codes', to: '/objects' }, { label: 'Labels' }]}
          title={`Print ${objects.length} label${objects.length === 1 ? '' : 's'}`}
          subtitle="Check the preview, then print — or save as PDF from the print dialog"
          actions={<><Button to="/objects">Back</Button><Button variant="primary" icon="printer" onClick={() => window.print()}>Print</Button></>}
        />
        <Card>
          <div className="row wrap" style={{ gap: 16 }}>
            <Select style={{ width: 170 }} aria-label="Code type" value={type} onChange={(e) => setType(e.target.value)} options={[{ value: 'qr', label: 'QR code' }, { value: 'barcode', label: 'Barcode (Code 128)' }]} />
            <Select style={{ width: 190 }} aria-label="Label size" value={size} onChange={(e) => setSize(e.target.value)} options={SIZES} />
            <Checkbox label="Object name" checked={show.name} onChange={(v) => setShow((s) => ({ ...s, name: v }))} />
            <Checkbox label="Object ID" checked={show.id} onChange={(v) => setShow((s) => ({ ...s, id: v }))} />
            <Checkbox label="Company name" checked={show.company} onChange={(v) => setShow((s) => ({ ...s, company: v }))} />
          </div>
          <div className="small muted" style={{ marginTop: 10 }}>
            Printed codes point at <span className="mono">{settings.base_url}/o/…</span> — keep that domain and the links last. Print on plain or adhesive label sheets; keep the white border around the code so scanners lock on quickly.
          </div>
        </Card>
      </div>

      {objects.length === 0 ? <EmptyState icon="printer" title="Nothing selected" message="Pick objects in the list, then choose Print labels." /> : (
        <div className="label-sheet" style={{ gridTemplateColumns: `repeat(${spec.columns}, minmax(0, 1fr))` }}>
          {objects.map((o) => (
            <div key={o.id} className="label">
              <LabelCode objectId={o.id} type={type} width={spec.code} />
              <div className="label-text">
                {show.name && <div className="label-name">{o.name}</div>}
                {show.id && <div className="label-id">{o.public_id}</div>}
                {show.company && <div className="label-company">{settings.company_name || 'Veritek Energy Systems'}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LabelCode({ objectId, type, width }) {
  const url = useBlobUrl(`/objects/${objectId}/code.png?type=${type}&scale=${type === 'qr' ? 8 : 2}`);
  return url ? <img src={url} alt="" style={{ width, height: type === 'qr' ? width : 'auto' }} /> : <span style={{ width, height: type === 'qr' ? width : 40, display: 'inline-block', background: '#f2f2f2' }} />;
}
