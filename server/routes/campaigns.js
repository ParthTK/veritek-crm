// Exhibitions & campaigns, plus the team view (members, targets and performance).
import { Router } from 'express';
import { intId } from '../util.js';
import { allow } from '../auth.js';
import { listCampaigns, campaignDetail, saveCampaign, saveVisit, deleteVisit } from '../services/campaigns.js';
import { teamMembers, targetsView, saveTargets, performance } from '../services/team.js';
import { h } from './helpers.js';

const r = Router();
const id = (req) => intId(req.params.id);

r.get('/campaigns', allow('campaigns.view'), h((req) => listCampaigns(req.query, req.user)));
r.get('/campaigns/:id', allow('campaigns.view'), h((req) => campaignDetail(id(req), req.user)));
r.post('/campaigns', allow('campaigns.edit'), h((req) => saveCampaign(null, req.body || {}, req.user), 201));
r.put('/campaigns/:id', allow('campaigns.edit'), h((req) => saveCampaign(id(req), req.body || {}, req.user)));

// Customers met at an exhibition: anyone who handles enquiries can record them.
r.post('/campaigns/:id/visits', allow('campaigns.edit', 'enquiries.edit'), h((req) => saveVisit(id(req), null, req.body || {}, req.user), 201));
r.put('/campaigns/:id/visits/:visitId', allow('campaigns.edit', 'enquiries.edit'), h((req) => saveVisit(id(req), intId(req.params.visitId), req.body || {}, req.user)));
r.delete('/campaigns/:id/visits/:visitId', allow('campaigns.edit', 'enquiries.edit'), h((req) => deleteVisit(id(req), intId(req.params.visitId), req.user)));

r.get('/team/members', allow('team.view'), h((req) => teamMembers(req.user)));
r.get('/team/targets', allow('team.view'), h((req) => targetsView(req.query, req.user)));
r.put('/team/targets', allow('targets.edit'), h((req) => saveTargets(req.body || {}, req.user)));
r.get('/team/performance', allow('team.view'), h((req) => performance(req.query, req.user)));

export default r;
