-- Simpler forms (2026-11-18).
--
-- 1. "Website" is no longer a source of enquiries or customers. Removed from the list where nothing uses it;
--    if a record already does, it is only hidden from the list so that record keeps its label.
DELETE FROM dropdown_options WHERE category = 'enquiry_source' AND code = 'website'
  AND NOT EXISTS (SELECT 1 FROM enquiries WHERE source_code = 'website')
  AND NOT EXISTS (SELECT 1 FROM customers WHERE acquisition_source = 'website');
UPDATE dropdown_options SET active = 0 WHERE category = 'enquiry_source' AND code = 'website';

-- 2. Enquiry temperature (hot / warm / cold) is no longer used anywhere.
ALTER TABLE enquiries DROP COLUMN IF EXISTS temperature;
