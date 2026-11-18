// "New enquiry" from anywhere. What has been typed is kept if the panel is closed by accident.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Drawer, Button, useToast } from './ui.jsx';
import { useMeta } from './domain.jsx';
import { EnquiryForm, newEnquiryDraft } from './forms.jsx';

const Ctx = createContext(null);
export const useQuickEntry = () => useContext(Ctx);
const DRAFT_KEY = 'veritek.quick.enquiry';

function loadDraft() {
  try {
    return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
  } catch {
    return null;
  }
}

export function QuickEntryProvider({ children }) {
  const { user } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const toast = useToast();
  const [isOpen, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => ({ ...newEnquiryDraft(user, meta), ...(loadDraft() || {}) }));
  useEffect(() => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* ignore */
    }
  }, [draft]);
  // Opened from a customer or an exhibition: start a fresh enquiry already filled in with them.
  const open = useCallback((_kind, preset = null) => {
    if (preset) setDraft({ ...newEnquiryDraft(user, meta), ...preset });
    setOpen(true);
  }, [user, meta]);
  const close = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ open, close }), [open, close]);
  const clear = () => setDraft(newEnquiryDraft(user, meta));
  return (
    <Ctx.Provider value={value}>
      {children}
      <Drawer open={isOpen} wide onClose={close} title="New enquiry">
        <div className="stack">
          <EnquiryForm draft={draft} onChange={setDraft} onSaved={(res) => {
            toast.success('Enquiry saved');
            clear();
            close();
            window.dispatchEvent(new Event('data:changed'));
            navigate(`/enquiries/${res.id}`);
          }} />
          <div><Button size="sm" variant="ghost" icon="x" onClick={clear}>Clear</Button></div>
        </div>
      </Drawer>
    </Ctx.Provider>
  );
}
