// The sales pipeline: every live deal from enquiry to dispatch, and the journey of a single record.
import { Router } from 'express';
import { allow } from '../auth.js';
import { salesPipeline, journeyFor } from '../services/pipeline.js';
import { h } from './helpers.js';

const r = Router();

r.get('/pipeline', allow('enquiries.view', 'orders.view'), h((req) => salesPipeline(req.query, req.user)));
r.get('/pipeline/journey', allow('enquiries.view', 'orders.view', 'quotes.view'), h((req) => ({ journey: journeyFor(req.query, req.user) })));

export default r;
